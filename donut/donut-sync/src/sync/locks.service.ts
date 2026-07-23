import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { UserContext } from "../auth/user-context.interface.js";
import type {
  LockAcquireRequestDto,
  LockAcquireResponseDto,
  LockOkResponseDto,
  LockRefRequestDto,
  LocksListResponseDto,
} from "./dto/locks.dto.js";

/**
 * Cross-device profile mutual exclusion ("profile P is open on device A, so
 * device B must not open it").
 *
 * Locks are stored as tiny JSON objects at `locks/<profileId>.json`, written by
 * the SERVER's own S3 client — deliberately NOT via the presign path, so no
 * change-manifest bump ever fires, and `locks/` is outside the four prefixes
 * the SSE subscribe loop watches. A lock heartbeat therefore causes ZERO sync
 * traffic on any device. (Putting locks under `profiles/` would make every
 * heartbeat look like a profile change and re-trigger sync storms.)
 *
 * Liveness: the holder heartbeats every ~30s; a lock whose heartbeat is older
 * than LOCK_TTL_MS is stale (holder crashed / lost power) and can be taken
 * over. Same-device re-acquire always succeeds (app restart must not deadlock
 * against its own stale lock).
 */
interface StoredLock {
  profileId: string;
  deviceId: string;
  deviceName: string;
  heartbeatAt: string; // ISO timestamp of the last heartbeat
}

/** Heartbeats come every ~30s; three missed beats = the holder is gone. */
const LOCK_TTL_MS = 90_000;

@Injectable()
export class LocksService {
  private readonly logger = new Logger(LocksService.name);
  private s3: S3Client;
  private bucket: string;

  constructor(configService: ConfigService) {
    const endpoint =
      configService.get<string>("S3_ENDPOINT") || "http://localhost:8987";
    const region = configService.get<string>("S3_REGION") || "us-east-1";
    const accessKeyId =
      configService.get<string>("S3_ACCESS_KEY_ID") || "minioadmin";
    const secretAccessKey =
      configService.get<string>("S3_SECRET_ACCESS_KEY") || "minioadmin";
    const forcePathStyle =
      configService.get<string>("S3_FORCE_PATH_STYLE") !== "false";
    this.bucket = configService.get<string>("S3_BUCKET") || "donut-sync";
    this.s3 = new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  private prefix(ctx: UserContext): string {
    return ctx.mode === "self-hosted" ? "" : ctx.prefix;
  }

  private key(ctx: UserContext, profileId: string): string {
    // Reject path tricks — profileId is a UUID in practice.
    const safe = profileId.replace(/[^a-zA-Z0-9-]/g, "");
    return `${this.prefix(ctx)}locks/${safe}.json`;
  }

  private isFresh(lock: StoredLock): boolean {
    const t = Date.parse(lock.heartbeatAt);
    return Number.isFinite(t) && Date.now() - t < LOCK_TTL_MS;
  }

  private async read(key: string): Promise<StoredLock | null> {
    try {
      const r = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const body = await r.Body?.transformToString();
      return body ? (JSON.parse(body) as StoredLock) : null;
    } catch {
      return null;
    }
  }

  private async write(key: string, lock: StoredLock): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(lock),
        ContentType: "application/json",
      }),
    );
  }

  async acquire(
    dto: LockAcquireRequestDto,
    ctx: UserContext,
  ): Promise<LockAcquireResponseDto> {
    const key = this.key(ctx, dto.profileId);
    const current = await this.read(key);

    // Held fresh by ANOTHER device → refuse.
    if (current && this.isFresh(current) && current.deviceId !== dto.deviceId) {
      return {
        acquired: false,
        lockedBy: current.deviceId,
        lockedByName: current.deviceName,
        heartbeatAt: current.heartbeatAt,
      };
    }

    // Free, stale, or our own (re-entrant) → (re)take it.
    await this.write(key, {
      profileId: dto.profileId,
      deviceId: dto.deviceId,
      deviceName: dto.deviceName ?? "",
      heartbeatAt: new Date().toISOString(),
    });
    this.logger.log(
      `Lock acquired: ${dto.profileId} by ${dto.deviceName ?? dto.deviceId}`,
    );
    return { acquired: true };
  }

  async heartbeat(
    dto: LockRefRequestDto,
    ctx: UserContext,
  ): Promise<LockOkResponseDto> {
    const key = this.key(ctx, dto.profileId);
    const current = await this.read(key);
    if (!current || current.deviceId !== dto.deviceId) {
      return { ok: false };
    }
    current.heartbeatAt = new Date().toISOString();
    await this.write(key, current);
    return { ok: true };
  }

  async release(
    dto: LockRefRequestDto,
    ctx: UserContext,
  ): Promise<LockOkResponseDto> {
    const key = this.key(ctx, dto.profileId);
    const current = await this.read(key);
    // Only the holder may release; anyone else's release is a no-op.
    if (current && current.deviceId === dto.deviceId) {
      try {
        await this.s3.send(
          new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
        );
      } catch {
        // Best-effort: a failed delete just leaves a lock that expires by TTL.
      }
      this.logger.log(`Lock released: ${dto.profileId}`);
      return { ok: true };
    }
    return { ok: false };
  }

  async list(ctx: UserContext): Promise<LocksListResponseDto> {
    const prefix = `${this.prefix(ctx)}locks/`;
    const locks: StoredLock[] = [];
    let token: string | undefined;
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          MaxKeys: 1000,
          ContinuationToken: token,
        }),
      );
      for (const obj of page.Contents || []) {
        if (!obj.Key) continue;
        const lock = await this.read(obj.Key);
        if (lock && this.isFresh(lock)) locks.push(lock);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return { locks };
  }
}
