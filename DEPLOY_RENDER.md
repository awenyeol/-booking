# Render 云端部署说明（校内测试版）

这个目录已经可以直接作为 Git 仓库上传并部署到 Render。

## 推荐方案：带持久磁盘

仓库根目录的 `render.yaml` 已配置：

- Python Web Service
- Singapore region
- `python server.py`
- `/api/health` 健康检查
- SQLite 数据库路径 `/var/data/booking_test.db`
- 1 GB Persistent Disk 挂载到 `/var/data`
- 管理员 PIN 通过 Render 环境变量输入，不写在代码/仓库中

> Render 的 Persistent Disk 需要可挂载磁盘的付费 Web Service。对预约数据而言，这个方案比临时文件系统安全，因为重新部署/重启不会把 SQLite 预约记录清掉。

## A. 上传到 GitHub

1. 在 GitHub 新建 **Private** repository，例如：`rgsg-g11-booking-test`。
2. 把本目录中的所有文件上传到仓库根目录。
3. 不要上传 `booking_test.db` 或任何 `.env`；`.gitignore` 已经排除它们。

因为 `data/seed.json` 包含学生测试数据，仓库必须保持 Private。

## B. 在 Render 创建 Blueprint

1. 登录 Render。
2. 选择 **New → Blueprint**。
3. 连接上面的 Private GitHub repository。
4. Render 会读取根目录的 `render.yaml`。
5. 创建过程中会要求填写 `IHS_TEST_ADMIN_PIN`。
   - 请使用一个新的、较长的随机密码。
   - 不要继续使用 `OP-TEST-2026`。
6. 确认创建 Web Service 和 Persistent Disk。
7. 等待部署完成。

部署成功后会得到类似：

`https://rgsg-ihs-g11-booking-test.onrender.com`

## C. 部署后马上测试

打开：

`https://你的域名/api/health`

应看到类似：

```json
{"ok": true, "mode": "cloud-internal-test"}
```

然后：

1. 打开网站首页。
2. 进入 **OP / Admin**。
3. 输入部署时设置的管理员 PIN。
4. 点 **一键生成测试发布时段**。
5. 在“学生测试状态”里选择学生进行家长端预览。
6. 用两台设备同时抢同一个时段，确认只能有一位成功。
7. 测试取消后，确认时段重新开放。
8. 测试 CSV 导出。

## D. 重要说明

- 这是**校内测试版**，不是正式家长生产系统。
- Render Web Service 本身是公网 URL；请只把测试 URL/预约码发给校内测试人员。
- 家长预约码仍然是访问学生预约页面的凭证，请不要公开测试预约码表。
- 管理员 PIN 不再放进 URL；云端版通过请求头发送，避免进入浏览器历史/普通 URL 日志。
- SQLite + 单实例适合当前小规模内部测试；如果将来正式给全体家长长期使用，建议再升级账号权限、日志、备份及正式数据库。

## 免费演示方案（不建议保存真实预约）

目录中另有 `render-free-demo.yaml`，用于短时间 UI/流程演示。它没有 Persistent Disk，因此服务器重启或重新部署后，运行中产生的预约数据可能丢失。

如果只是想先看看网页是否能从外网打开，可以按它的配置手动创建 Free Web Service；真正多人测试预约时建议使用持久磁盘版。

## 本地仍然可以运行

Mac / Linux：

```bash
python3 server.py
```

Windows：

```powershell
py server.py
```

本地默认管理员测试码仍为 `OP-TEST-2026`；Render 云端则强制要求设置环境变量中的新管理员 PIN。
