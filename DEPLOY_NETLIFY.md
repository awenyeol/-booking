# Netlify 部署说明

这个仓库已经改成 **Netlify 静态前端 + Netlify Functions + Netlify Database(Postgres)**。

## 在 Netlify 里部署

1. Netlify → Add new project → Import an existing project → GitHub。
2. 选择本仓库 `awenyeol/-booking`。
3. Netlify 会自动读取根目录 `netlify.toml`：
   - Publish directory: `static`
   - Functions directory: `netlify/functions`
4. 在 Project configuration → Environment variables 添加：
   - `IHS_TEST_ADMIN_PIN` = 你自己的管理员测试密码
5. 在 Data & Storage → Database 创建/启用 Netlify Database。
6. Trigger deploy / Deploy site。

部署成功后先访问：
`https://你的站点.netlify.app/api/health`

看到 `"ok": true` 即表示函数和数据库工作正常。

## 重要

- 原来的 `server.py` / `render.yaml` 是 Render 版本，Netlify 不会使用它们。
- Netlify 版本不再使用 SQLite；预约、锁定、取消等数据存储在 Postgres。
- `data/seed.json` 不在 publish 目录，所以不会作为静态文件公开。
- 这是校内测试版，不建议直接作为正式家长生产系统。
