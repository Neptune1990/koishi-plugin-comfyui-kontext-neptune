当然可以！下面是你的插件说明模板，已根据你的插件功能和特色进行了定制：

---

# koishi-plugin-comfyui-kontext-neptune

[![npm](https://img.shields.io/npm/v/koishi-plugin-comfyui-kontext-neptune?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-comfyui-kontext-neptune)

一个基于 [ComfyUI](https://github.com/comfyanonymous/ComfyUI) 和 Kontext Dev 模型的 [Koishi](https://koishi.chat) 第三方插件。支持单图和双图输入，集成 DeepSeek 提示词工程与翻译，适用于图片修改、融合、换衣等多种场景。

本插件支持分步上传图片，适配单图（如常规图生图）和双图（如融合/换衣）工作流。你可以选择直接用原始提示词、AI提示词工程，或仅翻译提示词后作图，满足不同创作需求。

## 用法

1. 安装并配置好 ComfyUI 服务，并准备好相应的工作流文件（如单图/双图工作流）；
2. 在 Koishi 插件市场或通过 npm 安装本插件并启用；
3. 在群聊中使用 `改图` 命令（单图修改）或 `融合` 命令（双图融合/换衣）；
4. 按照机器人提示依次上传图片，等待生成结果。

### 示例

- 单图修改：
  ```
  改图 把头发变成蓝色
  ```
  机器人会提示你上传一张图片，随后自动处理。

- 双图融合/换衣：
  ```
  融合 把图2的衣服穿到图1的女生身上
  ```
  机器人会提示你依次上传两张图片，随后自动处理。

- 支持 `-r`（原始提示词）、`-t`（翻译提示词）等选项：
  ```
  改图 -t 让她穿上红色连衣裙
  ```

## 特性

- 支持单图/双图输入，自动分步收集图片
- DeepSeek 提示词工程/翻译一键切换
- 兼容多种 ComfyUI 工作流
- 适合图片修改、融合、风格迁移等多场景

## 配置建议

- `load_image_node_ids` 为单图时用于 `改图`，为双图时用于 `融合`
- 推荐为不同用途准备不同的 ComfyUI 工作流文件

## 相关链接

- [ComfyUI](https://github.com/comfyanonymous/ComfyUI)
- [Koishi](https://koishi.chat)
- [DeepSeek](https://deepseek.com/)
- [Kontext Dev](https://github.com/kontext-dev)

---

如需更详细的配置说明或遇到问题，欢迎在 [GitHub Issues](https://github.com/Neptune1990/koishi-plugin-comfyui-kontext-neptune/issues) 反馈！
