# 测试与验证策略

## 分层策略

本项目把自动化测试分为两层：

1. **纯逻辑/Host 回归（默认 `npm test`）**
   - 使用 Node 内置 `node:test`。
   - 覆盖账号目录、SQLite 关系同步、mention 解析、消息去重、工具参数、CLI 错误归一化、插件激活，以及客户端构建产物中的来源注册逻辑。
   - 不依赖真实飞书授权、真实 DSH Web 进程或浏览器。
2. **人工运行态验收**
   - 只用于确认浏览器实际加载的 bundle、页面视觉效果和输入框中的真实 `@` 交互。
   - 变更客户端 bundle 或 profile 安装后，需要重新安装并重启 DSH Web；磁盘上的包校验一致不能替代运行态验证。

当前自动化回归命令：

```bash
npm run check
npm test
```

## `@` 飞书来源的自动化覆盖

`test/client-activation.test.mjs` 使用真实构建后的 `lib/client.js`，在真实 Cordis Context 中提供最小的 `slots`、`connection` 和 `inputTriggers` 服务，覆盖：

- `inputTriggers` 延迟提供后，`@feishu` 能注册；
- 客户端来源重复激活时，不因 `already registered` 让 fiber 失败；
- 父作用域释放后，来源被注销；
- 客户端 bundle 的 inject 列表只声明真实 Cordis 服务名。

这组测试不渲染完整 DSH 页面，但能自动捕获“第一次出现、后续激活消失”的注册生命周期回归。

## 官方 `dsh-client-test-runtime` 的适用边界

DSH 官方发布了 `@deepseek-ai/dsh-client-test-runtime@0.2.2-rc.2`，并提供 `SlotTestRuntime` 与整客户端 `TestClient/createClientTest`。它的设计适合在 DSH 源码 checkout 中测试真实 SlotRegistry、模块系统、bootClient、reload 与 DOM。

本插件是独立 npm 包，消费的是 DSH 发布后的 `lib/client.js`。该浏览器产物不是普通 ESM，而是：

```text
window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
```

而 `dsh-client-test-runtime` 的 roster 代码会直接 ESM import `@deepseek-ai/dsh-client-modules/client`、`@deepseek-ai/dsh-client-web/src/*` 等源码/客户端入口。直接在本项目的 Vitest 中消费 npm 构建产物时会出现：

```text
TypeError: exactPackageSpecifier is not a function
```

原因是 Vite/Vitest 对 ModuleLoader 包装的浏览器 bundle 外部化后得到空模块命名空间；仅增加 `ssr.noExternal`、安装 peer 依赖或预置 `window.__ModuleLoader__` 不能把该包装自动还原为普通 ESM。强行写 bundle 转换器还会与 DSH 的 CJS factory、源码导出和浏览器模块注册顺序产生不一致风险。

因此当前项目不把官方整客户端 runtime 作为 npm 包内的默认测试依赖，也不把人工浏览器验收伪装成自动化通过。若未来需要整客户端测试，应在 DSH 源码仓库或官方源码测试环境中运行，使用其原生源码包与 bundle roster；本项目只保留稳定的构建产物生命周期测试。

## 需要人工确认的运行态场景

每次以下变更后，仍需人工重启 DSH Web 并检查浏览器 Console/Network：

- `package.json` 的 `dsh.client.inject` 或 `exports["./client"]`；
- `src/client/index.tsx` 的来源注册、slot 或输入管线；
- DSH、`dsh-client-ui-input-trigger` 或 profile bundle 版本；
- profile 中重新安装插件包。

验收重点：

1. 输入 `@` 后能看到 `当前账号：...` 分组及关系候选；
2. 选择候选能插入 mention chip；
3. 刷新、重启、HMR/插件重新激活后来源仍存在；
4. Console 无 `candidates failed`、`already registered` 或 `inputTriggers` 缺失错误；
5. Network 中客户端 bundle 来自当前安装版本。

人工验收是对真实运行态的补充，不替代已经存在的自动化回归。
