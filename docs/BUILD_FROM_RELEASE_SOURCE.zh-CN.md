# 从 3.2.0 r4 完整源码包构建

请下载 Release 附件 [Web-Harness-3.2.0-r4-source.zip](https://github.com/jamesmendax/chatgpt-web-harness/releases/download/v3.2.0-r4/Web-Harness-3.2.0-r4-source.zip)，并用同页 SHA256SUMS.txt 核对。附件包含源码、锁文件、许可证，以及构建要求的固定 Browser Use/Chrome 和 Tunnel 运行时；不含已安装 npm 依赖。

Git 仓库及 GitHub 自动生成的 Source code 归档不含被忽略的 bin/ 与 vendor/browser-use/ 大型二进制。需要从 Git 检出构建时，请使用同一标签的完整源码附件补齐这两个目录，保留其中的 provenance 和许可文件。

在 Windows x64、Node.js 24 与 npm 环境下，从解压后的源码根目录执行：

```powershell
.\BUILD.ps1
```

BUILD.ps1 使用根目录和 desktop 下的两份 package-lock.json 安装依赖，然后编译并打包。Tunnel 二进制按 third-party/tunnel-client/PROVENANCE.json 校验；Browser Use 运行时也保留其来源与哈希记录。

本次上传的两份 EXE 是原始 r4 已验证构建，内部版本仍为 3.2.0，发布标签为 v3.2.0-r4。再次构建的安装器可能因时间戳等因素得到不同字节哈希，不承诺逐字节可重现。

公开源码移除了私人交接、代理会话说明和生成日志，并使用公开仓库的 README/安全说明；生产实现和构建脚本保留受测版本的原始内容。Skills 回归测试的可选旧版基线默认目录改为项目内的 `.validation/skill-baseline/skills/anthropic-official-skills`，仍可用 `WH_SKILL_BASELINE` 显式指定；该变化只移除了开发机专用路径。Git 文本文件沿用仓库已有换行格式，完整源码 ZIP 保留所交付文件的实际字节。原始受测源码签名、公开源码清单及验证范围分别记录在 Release 附件中。
