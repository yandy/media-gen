# 发布新版本

发布由 GitHub Actions 完成：创建 GitHub Release（tag 格式 `vX.Y.Z`）触发
`.github/workflows/publish.yml`，执行 `npm ci` + `npm test` + `npm publish --provenance`。
认证走 OIDC trusted publishing，仓库里没有任何 npm token，发布机上也不需要 2FA。

发布到：`@yandy0725/mediagen-cli@X.Y.Z`（public access，带 provenance 签名）。

## 一次性配置（第一次自动发布前必须做完）

npmjs.com → `@yandy0725/mediagen-cli` → Settings → Trusted Publisher → GitHub Actions：

- Organization or user: `yandy`
- Repository: `mediagen-cli`
- Workflow filename: `publish.yml`
- Environment: 留空

没配之前，publish 步骤会失败（拿不到可用的 OIDC 凭据）。

## 发布步骤

```bash
# 1. 确认全部通过（CI 也会跑，但发布前自己看一眼）
npm run typecheck && npm test

# 2. 升级版本号并提交（不打 tag）
npm version <x.y.z> --no-git-tag-version
git add package.json package-lock.json
git commit -m "v<x.y.z>"
COMMIT=$(git rev-parse HEAD)

# 3. 推送
git push origin main

# 4. 创建 GitHub Release（gh 自动创建 tag，无需手动 git tag）
gh release create v<x.y.z> --target $COMMIT --title "v<x.y.z>" --notes ""

# 5. 看 workflow
gh run watch
```

## 注意事项

- tag 格式必须是 `vX.Y.Z`。`publish.yml` 的第一步会校验它等于 `v` + `package.json` 的
  `version`：裸 `x.y.z`、或者版本号没升就发 Release，都会在这一步失败。
- `gh release create` 自己建 tag，不需要手动 `git tag`；`--target` 确保 tag 落在升版本
  的那个 commit 上。只 `git tag` + `git push --tags` 不会触发发布 —— 触发事件是
  `release: published`。
- 发布后 npm registry 约 5 分钟后才可见：`npm publish` 返回 202 并提示
  "being processed and may take a few minutes"，此时 `npm view` 拿到 404 不代表失败，
  过几分钟再查。
- 失败的 Release 不能原地重跑：版本号一旦发出去就不能复用（`E403`），改
  `package.json` 升个号，再建新 Release。
- 应急的本地发布：`npm login`（security key 2FA）+ `npm publish` 仍然可用，但没有
  provenance，npm 包页不会显示 "Built and signed on GitHub Actions"。
- CI（`.github/workflows/test.yml`）在 `push` 到 `main` 和所有 PR 上跑，只在
  `ubuntu-latest` + Node 24。Windows 不在矩阵里：`tests/cli.entry.test.ts` 直接 spawn
  npm 的 `.bin` shim，Windows 上那是 `.cmd`，不是一次矩阵配置能解决的。
