# OpenList Enhanced (Mod)

这是一个 **OpenList** 的魔改版本。

本项目在保留原版所有功能和数据结构的基础上，重构了上传逻辑。
**核心目的只有一个：绕过 Cloudflare CDN 等反代服务的上传大小限制。**

**主打一个：替换即用，拒绝折腾。**

## 🚀 核心修改

## 🚀 核心修改：绕过 CDN 限制原理

本项目针对 CDN（如 Cloudflare 免费版限制单次请求 100MB）的上传体限制，实现了两种完全不同的“物理绕过”机制。

### 1. Form 分片模式 (Chunked Upload)
这是传统的、高兼容性的分片机制，核心是 **“落盘合并”**。

*   **工作流程**：
    1.  **前端切片**：前端将大文件切分为多个小块（默认 50MB）。
    2.  **分片上传**：每个小块作为独立的 `multipart/form-data` 请求发送。
    3.  **后端落盘**：服务端接收每个分片，并将其作为临时文件保存到服务器磁盘。
    4.  **最终合并**：所有分片上传完成后，前端发起合并请求。服务端将所有临时文件按顺序读入并合并为一个大文件。
    5.  **异步上传**：合并完成后，服务端启动后台任务将最终文件推送到云端存储。
*   **优势**：兼容性极强，支持断点续传（通过检查已存在的临时分片）。
*   **限制**：需要服务器有足够的**临时磁盘空间**来存储完整文件；合并过程会产生大量的磁盘 I/O。

### 2. Stream 分片模式 (New! Stream Chunking)
这是专为追求极致性能和低资源占用的用户设计的方案，核心是 **“零拷贝管道”**。

*   **工作流程**：
    1.  **前端流式切片**：前端利用 `Blob.slice` 将大文件在逻辑上分块（默认 95MB）。
    2.  **Range PUT 请求**：前端使用原生 `PUT` 方法发送 `Raw Binary` 数据，并携带 `Content-Range` 请求头。
    3.  **io.Pipe 桥接**：
        - 接收到第一个分片时，后端在内存中创建一个 **无缓冲管道 (`io.Pipe`)**。
        - 后端立即启动存储驱动的上传任务，驱动从管道的 `Reader` 端实时读取数据。
        - 后端将接收到的当前 HTTP 请求 Body 实时写入管道的 `Writer` 端。
    4.  **分片连续流**：后续的每个分片请求都会命中同一个管道会话。数据就像流水一样，直接从“前端请求”经由“服务器内存”流向“云端存储”。
    5.  **最后合并**：最后一个分片传完后，后端关闭管道，云端任务自动完成并确认。
*   **优势**：
    - **零磁盘占用**：服务器完全不需要存储临时分片，也不需要磁盘合并过程。
    - **极低内存压力**：通过管道的同步阻塞（背压）机制，内存始终只维持 KB 级的缓冲，带宽跑多快，数据传多快。
    - **高性能**：绕过了 CDN 的 Body 限制，同时保持了原生 Stream 上传的零额外开销。
*   **注意**：此模式下服务器作为“同步管道”，如果云端速度极慢，会通过 TCP 窗口自动限制用户上传速度。

![原理示意图](/演示图.png)

---

## ⚙️ 部署指南
## docker:部署
docker run -d --name openlist -p 5244:5244 -v "/opt/openlist/data:/opt/openlist/data" --restart always lusiya/openlist-chunk:latest

### ⚠️ 编译警告
**强烈不建议**在 Windows 下交叉编译 Linux 版本（由于 CGO 和 SQLite 的兼容性玄学问题）。
请务必在**目标系统（Linux 服务器）上直接进行原生编译**。

### 1. Frontend Build
```bash
# Enter frontend directory
cd OpenList-Frontend-main
# Install dependencies (use --legacy-peer-deps to avoid solid-js/vite conflicts)
npm install --legacy-peer-deps
# Build
npm run build
# Sync artifacts to backend public directory
# Windows
xcopy /e /i /y dist ..\public\dist
# Linux/macOS
cp -r dist/* ../public/dist/
```

### 2. Backend Build
Requires [GCC](https://jmeubank.github.io/tdm-gcc/) (for SQLite driver compilation).
```powershell
# Windows (PowerShell)
$env:CGO_ENABLED=1  # Enable CGO for SQLite support
$env:CC="gcc"       # Specify GCC compiler
go build -o openlist.exe -tags=jsoniter -ldflags="-s -w" .
```

```bash
# Linux
export CGO_ENABLED=1
go build -o openlist -tags=jsoniter -ldflags="-s -w" .
```

---

## ⚙️ Deployment Guide
安装/更新
本项目与原版数据库**完美兼容**。

1.  停止正在运行的 OpenList 服务。
2.  备份原版 `openlist` 二进制文件（以防万一）。
3.  将编译好的新 `openlist` 文件覆盖进去。
4.  启动服务。

```bash
# 简单粗暴的替换命令示例
systemctl stop openlist
cp openlist /opt/openlist/openlist
chmod +x /opt/openlist/openlist
systemctl start openlist
```

---

## 🛣️ 画饼 (Roadmap)

- [√] **Stream 分片**：未来计划让 Stream 模式也支持分片上传。
- [ ] **多线程下载**：浏览器端的多线程并发下载（目前还没写好，别急）。

---

## 📝 免责声明 (Disclaimer)

*   **关于 Bug**：你可以提交 Issue 反馈 Bug，我会看，**但我不保证能修**（精力有限，主打一个“能用就行”）。
*   **关于兼容性**：修改了上传 API 接口，请务必同时替换前端和后端，不要混用原版。
*   **感谢openlist项目的开发者们！**：遵守原项目的一切协议！
---

*Based on OpenList v4.*