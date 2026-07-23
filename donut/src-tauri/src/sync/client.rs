use super::types::*;
use reqwest::Client;
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::time::Duration;

/// TCP/TLS connect timeout. A dead peer must fail fast, not hang a whole sync.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Per-request cap for small control-plane calls (stat/list/presign/delete).
const CONTROL_TIMEOUT: Duration = Duration::from_secs(60);
/// Per-request cap for a single file transfer (GET/PUT of one profile file).
/// Generous so a large blob on a slow link isn't cut off, but still bounded so
/// a stalled socket can never freeze the scheduler forever.
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(600);
/// Max retries for a control-plane call before surfacing the error.
const MAX_CONTROL_RETRIES: u32 = 4;

/// Exponential backoff with jitter for a control-plane retry. Base 300ms,
/// doubling, capped at 5s, plus up to 250ms of jitter to avoid two devices
/// retrying in lockstep. Jitter is derived from the clock (no rng dependency).
async fn backoff_sleep(attempt: u32) {
  let base = 300u64.saturating_mul(1u64 << attempt.min(4));
  let jitter = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| (d.subsec_nanos() % 250) as u64)
    .unwrap_or(0);
  tokio::time::sleep(Duration::from_millis(base.min(5000) + jitter)).await;
}

#[derive(Clone)]
pub struct SyncClient {
  client: Client,
  base_url: String,
  token: String,
}

impl SyncClient {
  pub fn new(base_url: String, token: String) -> Self {
    // A connect timeout bounds every request at the dial stage; per-request
    // `.timeout()` calls below bound the transfer stage. Without these a single
    // stalled request would block the scheduler tick indefinitely.
    let client = Client::builder()
      .connect_timeout(CONNECT_TIMEOUT)
      .build()
      .unwrap_or_else(|_| Client::new());
    Self {
      client,
      base_url: base_url.trim_end_matches('/').to_string(),
      token,
    }
  }

  fn url(&self, path: &str) -> String {
    format!("{}/v1/objects/{}", self.base_url, path)
  }

  /// POST a JSON body to a control-plane endpoint and decode the JSON response,
  /// with bounded retry + backoff. Retries transient failures (connect/timeout,
  /// 429, 5xx); a 4xx is a hard error (surfaced as `AuthError`) and never
  /// retried. This is the single choke point that gives every control-plane
  /// call a timeout and retry, so one flaky request no longer aborts a sync.
  async fn post_json<Req, Res>(&self, path: &str, body: &Req) -> SyncResult<Res>
  where
    Req: Serialize,
    Res: DeserializeOwned,
  {
    let url = self.url(path);
    let mut attempt = 0u32;
    loop {
      let result = self
        .client
        .post(&url)
        .header("Authorization", format!("Bearer {}", self.token))
        .timeout(CONTROL_TIMEOUT)
        .json(body)
        .send()
        .await;

      match result {
        Ok(resp) => {
          let status = resp.status();
          if status.is_success() {
            return resp
              .json::<Res>()
              .await
              .map_err(|e| SyncError::SerializationError(e.to_string()));
          }

          // 429 + 5xx are transient; retry with backoff. 4xx is a hard error.
          let retryable = status.as_u16() == 429 || status.is_server_error();
          if retryable && attempt < MAX_CONTROL_RETRIES {
            attempt += 1;
            log::debug!("Retry {attempt}/{MAX_CONTROL_RETRIES} for {path}: HTTP {status}");
            backoff_sleep(attempt).await;
            continue;
          }

          let body_txt = resp.text().await.unwrap_or_default();
          return if status.is_client_error() {
            Err(SyncError::AuthError(format!("({status}) {body_txt}")))
          } else {
            Err(SyncError::NetworkError(format!(
              "Server error {status}: {body_txt}"
            )))
          };
        }
        Err(e) => {
          let retryable = e.is_timeout() || e.is_connect() || e.is_request();
          if retryable && attempt < MAX_CONTROL_RETRIES {
            attempt += 1;
            log::debug!("Retry {attempt}/{MAX_CONTROL_RETRIES} for {path}: {e}");
            backoff_sleep(attempt).await;
            continue;
          }
          return Err(SyncError::NetworkError(e.to_string()));
        }
      }
    }
  }

  pub async fn stat(&self, key: &str) -> SyncResult<StatResponse> {
    self
      .post_json(
        "stat",
        &StatRequest {
          key: key.to_string(),
        },
      )
      .await
  }

  pub async fn presign_upload(
    &self,
    key: &str,
    content_type: Option<&str>,
  ) -> SyncResult<PresignUploadResponse> {
    self
      .presign_upload_with_metadata(key, content_type, None)
      .await
  }

  /// Presign an upload, asking the server to sign `metadata` into the object as
  /// `x-amz-meta-*`. The response echoes the metadata the server actually signed
  /// (empty/None on older servers); the caller must send exactly that back on
  /// the PUT via `upload_bytes_with_metadata`.
  pub async fn presign_upload_with_metadata(
    &self,
    key: &str,
    content_type: Option<&str>,
    metadata: Option<std::collections::HashMap<String, String>>,
  ) -> SyncResult<PresignUploadResponse> {
    self
      .post_json(
        "presign-upload",
        &PresignUploadRequest {
          key: key.to_string(),
          content_type: content_type.map(|s| s.to_string()),
          expires_in: Some(3600),
          metadata,
        },
      )
      .await
  }

  pub async fn presign_download(&self, key: &str) -> SyncResult<PresignDownloadResponse> {
    self
      .post_json(
        "presign-download",
        &PresignDownloadRequest {
          key: key.to_string(),
          expires_in: Some(3600),
        },
      )
      .await
  }

  pub async fn delete(&self, key: &str, tombstone_key: Option<&str>) -> SyncResult<DeleteResponse> {
    self
      .post_json(
        "delete",
        &DeleteRequest {
          key: key.to_string(),
          tombstone_key: tombstone_key.map(|s| s.to_string()),
          deleted_at: Some(chrono::Utc::now().to_rfc3339()),
        },
      )
      .await
  }

  pub async fn list(&self, prefix: &str) -> SyncResult<ListResponse> {
    self.list_page(prefix, None).await
  }

  async fn list_page(
    &self,
    prefix: &str,
    continuation_token: Option<String>,
  ) -> SyncResult<ListResponse> {
    self
      .post_json(
        "list",
        &ListRequest {
          prefix: prefix.to_string(),
          max_keys: Some(1000),
          continuation_token,
        },
      )
      .await
  }

  /// List all objects under a prefix, paginating through all results
  pub async fn list_all(&self, prefix: &str) -> SyncResult<Vec<ListObject>> {
    let mut all_objects = Vec::new();
    let mut continuation_token: Option<String> = None;

    loop {
      let response = self.list_page(prefix, continuation_token).await?;
      all_objects.extend(response.objects);

      if !response.is_truncated {
        break;
      }
      continuation_token = response.next_continuation_token;
      if continuation_token.is_none() {
        break;
      }
    }

    Ok(all_objects)
  }

  pub async fn upload_bytes(
    &self,
    presigned_url: &str,
    data: &[u8],
    content_type: Option<&str>,
  ) -> SyncResult<()> {
    self
      .upload_bytes_with_metadata(presigned_url, data, content_type, None)
      .await
  }

  /// PUT to a presigned URL, sending `metadata` as `x-amz-meta-*` headers. These
  /// MUST be exactly the metadata the presign signed (from
  /// `PresignUploadResponse::metadata`) or S3 rejects the request.
  pub async fn upload_bytes_with_metadata(
    &self,
    presigned_url: &str,
    data: &[u8],
    content_type: Option<&str>,
    metadata: Option<&std::collections::HashMap<String, String>>,
  ) -> SyncResult<()> {
    let mut req = self
      .client
      .put(presigned_url)
      .timeout(TRANSFER_TIMEOUT)
      .header("Content-Length", data.len().to_string())
      .body(data.to_vec());

    if let Some(ct) = content_type {
      req = req.header("Content-Type", ct);
    }

    if let Some(meta) = metadata {
      for (k, v) in meta {
        req = req.header(format!("x-amz-meta-{k}"), v);
      }
    }

    let response = req
      .send()
      .await
      .map_err(|e| SyncError::NetworkError(e.to_string()))?;

    if !response.status().is_success() {
      let status = response.status();
      let body = response.text().await.unwrap_or_default();
      return Err(SyncError::NetworkError(format!(
        "Upload failed with status {status}: {body}"
      )));
    }

    Ok(())
  }

  pub async fn download_bytes(&self, presigned_url: &str) -> SyncResult<Vec<u8>> {
    let response = self
      .client
      .get(presigned_url)
      .timeout(TRANSFER_TIMEOUT)
      .send()
      .await
      .map_err(|e| SyncError::NetworkError(e.to_string()))?;

    if !response.status().is_success() {
      return Err(SyncError::NetworkError(format!(
        "Download failed with status: {}",
        response.status()
      )));
    }

    response
      .bytes()
      .await
      .map(|b| b.to_vec())
      .map_err(|e| SyncError::NetworkError(e.to_string()))
  }

  pub async fn presign_upload_batch(
    &self,
    items: Vec<(String, Option<String>)>,
  ) -> SyncResult<PresignUploadBatchResponse> {
    let chunk_size = 500;
    let mut all_items = Vec::new();

    for chunk in items.chunks(chunk_size) {
      let request = PresignUploadBatchRequest {
        items: chunk
          .iter()
          .map(|(key, content_type)| PresignUploadBatchItem {
            key: key.clone(),
            content_type: content_type.clone(),
          })
          .collect(),
        expires_in: Some(3600),
      };

      let batch_response: PresignUploadBatchResponse =
        self.post_json("presign-upload-batch", &request).await?;
      all_items.extend(batch_response.items);
    }

    Ok(PresignUploadBatchResponse { items: all_items })
  }

  pub async fn presign_download_batch(
    &self,
    keys: Vec<String>,
  ) -> SyncResult<PresignDownloadBatchResponse> {
    let chunk_size = 500;
    let mut all_items = Vec::new();

    for chunk in keys.chunks(chunk_size) {
      let request = PresignDownloadBatchRequest {
        keys: chunk.to_vec(),
        expires_in: Some(3600),
      };

      let batch_response: PresignDownloadBatchResponse =
        self.post_json("presign-download-batch", &request).await?;
      all_items.extend(batch_response.items);
    }

    Ok(PresignDownloadBatchResponse { items: all_items })
  }

  pub async fn delete_prefix(
    &self,
    prefix: &str,
    tombstone_key: Option<&str>,
  ) -> SyncResult<DeletePrefixResponse> {
    self
      .post_json(
        "delete-prefix",
        &DeletePrefixRequest {
          prefix: prefix.to_string(),
          tombstone_key: tombstone_key.map(|s| s.to_string()),
          deleted_at: Some(chrono::Utc::now().to_rfc3339()),
        },
      )
      .await
  }
}
