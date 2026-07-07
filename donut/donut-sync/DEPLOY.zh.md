# donut-sync 自托管部署（Token 模式）

Marine 用**自托管 token 模式**同步浏览器 profile：无账号、无注册，客户端只填
**服务器 URL + 一个共享 `SYNC_TOKEN`**。谁有这个 token 就能读写整份数据（不做多用户隔离）。

## 架构

单机 Docker，三个容器（HTTP，host 网络）：

| 容器 | 作用 | 端口 |
| --- | --- | --- |
| `minio` | S3 对象存储（数据都在这里） | 9000 API（公网）/ 9001 控制台（仅 127.0.0.1） |
| `createbucket` | 一次性建好 `donut-sync` 桶 | — |
| `sync` | donut-sync 服务（NestJS） | 12342 |

**关键**：`S3_ENDPOINT` 用**公网 IP**（如 `http://<IP>:9000`）。sync 服务既用它给客户端
签发预签名 URL，又用它直连 S3——host 网络让容器 hairpin 回自己的公网 IP，两条路径同一个 endpoint。

## 部署

```bash
cd donut-sync
cp .env.prod.example .env          # 填入强随机 SYNC_TOKEN + MinIO 用户名/密码 + 公网 S3_ENDPOINT
#   openssl rand -hex 32   生成 token / 密码
./deploy.sh root@<你的服务器IP>     # 组包 -> scp -> docker compose up -d --build -> /readyz 自检
```

然后在**云控制台安全组**放行端口 **12342**（sync）和 **9000**（MinIO S3）。9001 控制台绑定在
127.0.0.1，需要时用 SSH 隧道访问：`ssh -L 9001:127.0.0.1:9001 root@<IP>`。

## 自检

```bash
curl http://<IP>:12342/health     # {"status":"ok"}
curl http://<IP>:12342/readyz     # {"status":"ready","s3":true}  <- 确认能连上 MinIO
```

## 客户端

Donut 客户端里 `sync-config-dialog.tsx` 已把自托管服务器 URL 预填为默认（见
`DEFAULT_SELF_HOSTED_URL`）。使用者打开「同步设置 → 自托管」，只需**粘贴 `SYNC_TOKEN`** 再保存。
Token 是共享密钥，**不入库、不写进仓库**，通过其它渠道发给使用者。

## 运维

```bash
cd /opt/donut-sync
docker compose ps                 # 状态
docker compose logs -f sync       # 日志
docker compose restart sync       # 重启
docker compose down               # 停（数据在 minio_data 卷里，不丢）
```
