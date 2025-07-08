// lib/index.js (Final Version with 3 Prompt Modes: Engineer, Simple Translate, Raw)
const { Context, Schema, Logger, h } = require('koishi');
const { v4: uuidv4 } = require('uuid');
const FormData = require('form-data');
const axios = require('axios');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const logger = new Logger('comfyui-img2img');

exports.name = 'comfyui-img2img-file';

const WorkflowConfig = Schema.object({
  alias: Schema.string().description('工作流的别名，用于在指令中调用。').required(),
  is_default: Schema.boolean().description('是否为默认工作流？（只能有一个默认）').default(false),
  permission_level: Schema.number().description('使用此工作流所需的权限等级。0 为所有人可用。').default(0),
  file_path: Schema.string().description('此工作流的本地文件路径（API JSON格式）。').required(),
  load_image_node_id: Schema.string().description('此工作流中加载【输入图片】的节点的ID。').required(),
  positive_prompt_node_id: Schema.string().description('此工作流中填写【正面提示词】的节点的ID。').required(),
});

exports.Config = Schema.object({
  comfyui: Schema.object({
    server_address: Schema.string().description('ComfyUI 服务器地址').default('127.0.0.1:8188'),
    request_timeout: Schema.number().description('请求超时时间（秒）').default(120),
  }).description('ComfyUI 设置'),

  workflows: Schema.array(WorkflowConfig).description('工作流配置列表'),

  prompt_engineer: Schema.object({
    enable: Schema.boolean().description('是否启用 DeepSeek 功能。').default(false),
    deepseek_api_key: Schema.string().description('您的 DeepSeek API 令牌。').role('secret'),
  }).description('DeepSeek 功能设置 (用于提示词工程与翻译)'),
});

exports.apply = (ctx, config) => {
  const request_queue = [];
  let is_processing = false;
  const max_queue_size = 3;

  async function process_queue() {
    if (is_processing || request_queue.length === 0) return;
    is_processing = true;

    const { session, target_workflow_config, prompt_text, use_raw_prompt, use_simple_translate } = request_queue.shift();
    logger.info(`开始处理队列中的下一个任务 (工作流: ${target_workflow_config.alias})，剩余任务数: ${request_queue.length}`);

    const comfyui_client_id = uuidv4();

    try {
      const comfyui_address = config.comfyui.server_address;
      
      await session.send('开始处理您的请求... 预计需要2分钟左右，请耐心等待。');

      const imageElement = session.elements.find(e => e.type === 'image' || e.type === 'img') 
                        || (session.quote && session.quote.elements.find(e => e.type === 'image' || e.type === 'img'));
      
      let workflow;
      try {
        const absolutePath = path.resolve(ctx.baseDir, target_workflow_config.file_path);
        if (!fs.existsSync(absolutePath)) throw new Error(`找不到工作流文件: ${absolutePath}`);
        workflow = JSON.parse(fs.readFileSync(absolutePath, 'utf-8'));
      } catch (error) {
        throw new Error(`无法读取或解析工作流文件: ${error.message}`);
      }
      
      const imageResponse = await ctx.http.get(imageElement.attrs.src, { responseType: 'arraybuffer' });
      const imageName = `${uuidv4()}.png`;
      const formData = new FormData();
      formData.append('image', Buffer.from(imageResponse), { filename: imageName });
      formData.append('overwrite', 'true');
      await axios.post(`http://${comfyui_address}/upload/image`, formData, {
        headers: formData.getHeaders(),
        timeout: config.comfyui.request_timeout * 1000
      });
      logger.info(`图片 ${imageName} 上传成功`);

      const imageNodeId = target_workflow_config.load_image_node_id;
      const promptNodeId = target_workflow_config.positive_prompt_node_id;
      
      if (!workflow[imageNodeId] || !workflow[imageNodeId].inputs) throw new Error(`工作流 "${target_workflow_config.alias}" 中找不到ID为 "${imageNodeId}" 的图片加载节点。`);
      workflow[imageNodeId].inputs.image = imageName;

      let pure_prompt = prompt_text ? prompt_text.replace(/<img[^>]*>/g, '').trim() : '';
      
      // ===================================================================
      //  !!! 这是本次功能升级的核心 (1/2) !!!
      //  重构提示词处理逻辑，以支持三种模式
      if (config.prompt_engineer.enable && pure_prompt) {
        if (!config.prompt_engineer.deepseek_api_key) {
           await session.send('（注意：DeepSeek 功能已启用，但未配置 API 令牌，将使用原始提示词。）');
        } else {
            // 模式一：原始模式
            if (use_raw_prompt) {
                logger.info('检测到 -r 选项或关键词，跳过 DeepSeek 处理。');
            // 模式二：纯翻译模式
            } else if (use_simple_translate) {
                try {
                    logger.info('检测到 -t 选项，正在使用简单翻译模式...');
                    const translated_prompt = await translate_simple_text(
                        pure_prompt,
                        config.prompt_engineer.deepseek_api_key
                    );
                    logger.info(`简单翻译成功: "${pure_prompt}" -> "${translated_prompt}"`);
                    pure_prompt = translated_prompt; // 使用翻译后的提示词
                } catch (e) {
                    logger.error(`DeepSeek 简单翻译失败: ${e.message}`);
                    await session.send('翻译失败，将使用原始提示词。');
                }
            // 模式三：提示词工程模式（默认）
            } else {
                try {
                    logger.info('正在使用默认的提示词工程模式...');
                    const engineered_prompt = await generate_structured_prompt(
                        pure_prompt,
                        config.prompt_engineer.deepseek_api_key
                    );
                    logger.info(`提示词工程成功: "${pure_prompt}" -> "${engineered_prompt}"`);
                    pure_prompt = engineered_prompt;
                } catch (e) {
                    logger.error(`DeepSeek 提示词工程失败: ${e.message}`);
                    await session.send('提示词工程失败，将使用原始提示词。');
                }
            }
        }
      }
      // ===================================================================

      if (pure_prompt && workflow[promptNodeId] && workflow[promptNodeId].inputs) {
        if (workflow[promptNodeId].inputs.prompt !== undefined) {
            workflow[promptNodeId].inputs.prompt = pure_prompt;
        } else if (workflow[promptNodeId].inputs.text !== undefined) {
            workflow[promptNodeId].inputs.text = pure_prompt;
        }
      } else if (pure_prompt && !workflow[promptNodeId]) {
          throw new Error(`工作流 "${target_workflow_config.alias}" 中找不到ID为 "${promptNodeId}" 的提示词节点。`);
      }
      
      const ksamplerNode = Object.values(workflow).find(node => node.class_type === 'KSampler');
      if (ksamplerNode && ksamplerNode.inputs.seed !== undefined) {
          ksamplerNode.inputs.seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
      }

      const ws = new WebSocket(`ws://${comfyui_address}/ws?clientId=${comfyui_client_id}`);
      
      const generatedImages = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) ws.close();
          reject(new Error('请求超时'));
        }, config.comfyui.request_timeout * 1000);
        
        let promptId = null;

        ws.on('open', async () => {
          try {
            const payload = { prompt: workflow, client_id: comfyui_client_id };
            const response = await axios.post(`http://${comfyui_address}/prompt`, payload);
            promptId = response.data.prompt_id;
            logger.info(`[${session.guildId || session.userId}] 任务已提交, Prompt ID: ${promptId}`);
          } catch (err) {
              reject(new Error(`提交工作流失败: ${err.message}`));
          }
        });

        ws.on('message', (data) => {
          const message = JSON.parse(data.toString());
          if (message.type === 'executed' && message.data.prompt_id === promptId) {
            if (message.data.output.images) {
              const saveImageNodeId = Object.keys(workflow).find(key => workflow[key].class_type === 'SaveImage');
              if (message.data.node === saveImageNodeId) {
                  logger.info(`[${session.guildId || session.userId}] 任务 ${promptId} 已完成`);
                  clearTimeout(timeout);
                  if (ws.readyState === WebSocket.OPEN) ws.close();
                  resolve(message.data.output.images);
              }
            }
          } else if (message.type === 'execution_error' && message.data.prompt_id === promptId) {
              clearTimeout(timeout);
              if (ws.readyState === WebSocket.OPEN) ws.close();
              reject(new Error('ComfyUI 处理时发生错误。'));
          }
        });

        ws.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      if (generatedImages && generatedImages.length > 0) {
          for (const imgData of generatedImages) {
              const imageUrl = `http://${comfyui_address}/view?filename=${imgData.filename}&subfolder=${imgData.subfolder}&type=${imgData.type}`;
              await session.send(h.image(imageUrl));
          }
      } else {
          throw new Error('未能生成图片，请检查ComfyUI后台或日志。');
      }

    } catch (error) {
      logger.error(`[${session.guildId || session.userId}] 任务执行失败: ${error.message}`);
      session.send(`处理失败：${error.message}`);
    } finally {
      is_processing = false;
      logger.info(`一个任务结束，“工人”已空闲。检查队列中是否还有下一个任务...`);
      process_queue();
    }
  }
  
  ctx.command('img2img <prompt:text>', '使用ComfyUI进行图生图或翻译提示词')
    .alias('改图')
    .option('raw', '-r  直接使用原始提示词，不经过AI处理')
    .option('translateOnly', '-t  仅将提示词简单翻译为英文后，再生成图片')
    .action(async ({ session, options }, prompt_text) => {
      
      const full_prompt = prompt_text || '';
      
      const imageElement = session.elements.find(e => e.type === 'image' || e.type === 'img') 
                        || (session.quote && session.quote.elements.find(e => e.type === 'image' || e.type === 'img'));
      
      if (!imageElement) {
          return '错误：请在指令中附带一张图片，或回复一张图片。';
      }

      const words = full_prompt.split(' ').filter(word => word);
      const first_word = words[0] || '';
      
      let final_alias = null;
      let final_prompt = full_prompt;

      const matched_workflow = config.workflows.find(w => w.alias === first_word);

      if (matched_workflow) {
        final_alias = first_word;
        final_prompt = words.slice(1).join(' ');
      }
      
      let target_workflow_config;
      if (final_alias) {
        target_workflow_config = config.workflows.find(w => w.alias === final_alias);
      } else {
        target_workflow_config = config.workflows.find(w => w.is_default) || config.workflows[0];
      }

      if (!target_workflow_config) {
        return '错误：插件未配置任何工作流，无法处理请求。';
      }
      
      if (target_workflow_config.permission_level > session.user.authority) {
        return `您的权限不足 (level ${session.user.authority})，无法使用此工作流 (需要 level ${target_workflow_config.permission_level})。`;
      }
      
      if (request_queue.length >= max_queue_size) {
        return `处理队列已满 (最大: ${max_queue_size})，请稍后再试。`;
      }
      
      // ===================================================================
      //  !!! 这是本次功能升级的核心 (2/2) !!!
      //  将所有模式的标志一起放入队列
      request_queue.push({ 
        session, 
        target_workflow_config, 
        prompt_text: final_prompt,
        use_raw_prompt: options.raw || (final_prompt.toLowerCase() === 'remove clothes'),
        use_simple_translate: options.translateOnly
      });
      // ===================================================================
      
      await session.send(`排队中 (第 ${request_queue.length} 位)...`);
      logger.info(`新请求加入队列。当前队列长度: ${request_queue.length}`);
      
      process_queue();
    });
};

async function translate_simple_text(text, apiKey) {
    const url = 'https://api.deepseek.com/chat/completions';
    const system_prompt = 'You are a translation engine. Please translate the following text to English. Output only the translated text, without any explanations or other content.';

    const payload = {
        model: 'deepseek-chat',
        messages: [
            { role: 'system', content: system_prompt },
            { role: 'user', content: text },
        ],
        stream: false,
    };
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
    };
    const response = await axios.post(url, payload, { headers });
    if (response.data && response.data.choices && response.data.choices[0].message) {
        return response.data.choices[0].message.content.trim();
    } else {
        throw new Error('No translated text found in DeepSeek API response.');
    }
}

async function generate_structured_prompt(text, apiKey) {
    const url = 'https://api.deepseek.com/chat/completions';
    const system_prompt = `
## 🔧 基础提示规则（rule）
- 所有修改必须明确、具体，避免使用模糊词汇（如“美化”、“变好看”）
- 所有复杂变动必须拆分为多个步骤进行描述
- 指明哪些元素不变（角色特征、姿势、位置等）
- 修改动词必须使用 change / replace / convert / transform
---
## ✏️ 基础修改类（Basic Modification）
模板：
Change [object] to [new state], keep [elements_to_preserve] unchanged
示例：
- Change the car color to red
- Change the time to daytime while maintaining the same style of the painting
---
## 🎨 风格转换类（Style Conversion）
模板：
Transform to [specific style], while maintaining [elements_to_preserve]
示例：
- Transform to Bauhaus art style
- Convert to oil painting with visible brushstrokes and thick paint texture
- Convert to pencil sketch with natural graphite lines, cross-hatching, and visible paper texture
---
## 👤 角色一致性类（Character Consistency）
模板：
Change [aspect] of the character to [new state], while maintaining [facial features / hairstyle / pose / expression]
示例：
- Change the clothes to be a viking warrior while preserving facial features
- Update the background to a forest while keeping the woman with short black hair in the same pose and expression
---
## 🌅 背景替换类（Background Change）
模板：
Change the background to [new_background], keep the subject in the exact same [position / pose / scale]
示例：
- Change the background to a beach while keeping the person in the exact same position, scale, and pose
---
## 🔠 文本编辑类（Text Replacement）
模板：
Replace '[original_text]' with '[new_text]', maintain the same [font style / layout]
示例：
- Replace 'joy' with 'BFL', keeping the font style unchanged
---
## 🪜 分步骤编辑建议（Multi-Step Instruction）
Step 1: Change [background / lighting], keep the character in the same pose
Step 2: Change [clothing / expression / item], maintain facial features and hairstyle
Step 3: Transform to [desired art style], while preserving the entire composition
---
## ❌ 常见错误与修正建议（Common Mistakes）
错误：
Transform the person into a Viking
✅ 替代：
Change the clothes to be a viking warrior while preserving facial features
错误：
Put him on a beach
✅ 替代：
Change the background to a beach while keeping the person in the exact same position, scale, and pose
错误：
Make it a sketch
✅ 替代：
Convert to pencil sketch with natural graphite lines, cross-hatching, and visible paper texture
---
# 💡 核心结构记忆口诀：
- change：用于修改具体物体属性
- transform：用于风格变化或视觉风格替换
- replace：用于文本替换
- maintain / keep：强调保留特征或构图元素
## 输出示例
- 用户输入：把这个汽车的颜色变成红色
- 响应输出：Change the car color to red
# 注意事项
- 根据用户输入进行规则改写
- 不能输出与用户输入无关的内容
- 输出直接给出标准结果，并且是一段话，不要分段列举以及加入备注等。
以上是提示词的撰写要求，你需要按照要求撰写提示词，不可以忘记以上要求。
现在我开始说需求，你用一段话写出提示词，要求英语，并且不要分段列举以及加入备注等。
    `;

    const payload = {
        model: 'deepseek-chat',
        messages: [
            { role: 'system', content: system_prompt },
            { role: 'user', content: text },
        ],
        stream: false,
    };
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
    };
    const response = await axios.post(url, payload, { headers });
    if (response.data && response.data.choices && response.data.choices[0].message) {
        return response.data.choices[0].message.content.trim();
    } else {
        throw new Error('No structured prompt found in DeepSeek API response.');
    }
}