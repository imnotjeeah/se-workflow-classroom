# SE Workflow｜同学交接

这是课堂作业 2 的源码包。流程从 Design Spec 开始，由 PM Agent 调用 DeepSeek API 拆解开发任务，再由编排器计算依赖和执行批次。界面支持按需求追踪任务、查看依赖原因、调整并行上限，以及导出 Markdown 计划和可回放的 JSON。

## 先打开看一遍

1. 完整解压。电脑需要 Node.js 22 或更新版本。
2. Windows 上双击 `Start.cmd`，或在项目目录运行 `npm start` 后访问 [工作台](http://127.0.0.1:8765/)。
3. 点击页面右上角的「DeepSeek 密钥」，输入自己的 API 密钥，选一个演示案例，点击「运行工作流」。密钥仅在当前页面使用，刷新后需重新输入。

包里已带可运行的前端文件，首次启动无需安装依赖。在线生成需要能访问 DeepSeek API 和可用的 API 密钥。若有之前从工作台导出的 DeepSeek JSON，可以通过「导入 DeepSeek 结果 JSON」离线回放。

## 分工时从哪里改

| 要改的内容 | 修改位置 |
| --- | --- |
| 页面布局、样式、按钮及导出 | `index.html`、`style.css`、`app.mjs` |
| 两份演示 Design Spec | `examples.mjs` |
| PM Agent 提示词、DeepSeek 请求、错误处理 | `server.mjs` |
| 任务校验、交付物依赖、测试前置、执行批次 | `workflow.mjs` |
| 前端构建和 Windows 程序打包 | `build.mjs` |

`app.browser.js` 是构建生成的浏览器脚本。改动 `app.mjs`、`examples.mjs` 或 `workflow.mjs` 后，先在项目目录运行一次 `npm ci`，再运行 `npm run build` 并刷新页面。改了 `server.mjs` 或编排逻辑后，重启服务再验证。

## 构建可双击运行的程序

在 Windows x64 上使用 Node.js 26 或更新版本。运行 `npm ci` 和 `npm run build:windows` 后，生成文件是 `dist/SE-Workflow-Classroom.exe`。

## 改完后验证

先跑「旅游行程分配」，点每日时长限制对应的需求，检查关联的开发和测试任务。再换「校园活动报名」，点击一条依赖并查看前置交付物，将并行上限改为 1，确认每批只排一项。最后导出 JSON，再导入一次检查能否回放。详细上台顺序见《课堂展示与使用说明》。

编排器检查任务结构与先后关系。验收标准是否符合业务需要，仍要对照原始规格核对。压缩包未附带 API 密钥。
