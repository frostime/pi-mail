当前正在开发 Pi Coding Agent 的 mail 工具。

包括:

- ./extensions/pi-mail
- ./skills/pi-mail

---

启动时：使用 `pi -e ./extensions/pi-mail`

## 开发约定

TypeScript 开发依赖 PI HOME 全局提供的 PI 类型定义。不要自行增加 npm 依赖，尤其不要为了 PI 类型在本项目中安装或声明额外依赖。
