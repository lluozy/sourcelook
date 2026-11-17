# SourceLook 插件开发铁律

1. **不改 DSH。**
   - 不修改 DSH 的安装目录、`app.asar`、源码、资源文件、注册表或 DSH 自带配置。
   - 不要求用户为了安装/使用 SourceLook 去改 DSH 版本、打补丁或加启动参数。

2. **只通过插件公开能力工作。**
   - 使用 DSH 提供的插件入口、HTTP 注册、Session/Workspace 访问、client bundle 挂载点。
   - 不接管宿主窗口事件（例如 `removeAllListeners('close')`、改写 `BrowserWindow` 行为）。
   - 不 monkey-patch DSH 的全局对象、菜单、托盘、退出流程。

3. **必须区分“使用宿主 API”和“修改宿主行为”。**
   - 例如 `dialog.showOpenDialog` 是调用宿主 API 完成“选择目录”，可以。
   - 例如把主窗口的 close 改成 `app.quit()` 是改变宿主行为，不可以。

4. **如果确实必须改 DSH：先停下，不直接动手。**
   - 必须书面说明：要改哪个文件/版本、为什么插件层做不到、影响范围、如何回滚。
   - 必须得到用户明确同意后才执行。
   - 改动单独记录，不能混在插件提交里。

5. **验收标准：**
   - 在未修改的官方 DSH 上，把 SourceLook 作为插件安装即可使用。
   - 卸载插件后，DSH 行为恢复到安装前。

6. **绝不阻止宿主退出。**
   - 不注册 `beforeunload` / `onbeforeunload`，不拦截窗口 close，不阻止 `app.quit()`。
   - 未保存内容通过草稿自动保存处理；宁可丢一次编辑，也不能让用户无法退出 DSH。
   - 任何“退出前确认”只能做在插件自己的标签页关闭动作里，不能挂在宿主窗口上。