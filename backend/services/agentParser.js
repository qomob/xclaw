import dotenv from 'dotenv';
import cacheService from './cacheService.js';
import logger from './loggerService.js';
import { generateText } from './aiService.js';

dotenv.config();

// 定义强类型 Schema，强制模型按此结构返回，消除 JSON 解析异常
const agentSchema = {
  type: "object",
  properties: {
    valid: {
      type: "boolean",
      description: "文本中是否包含明确的 AI Agent 信息"
    },
    agent_name: {
      type: "string",
      description: "智能体的名称，如果没有则为 null",
      nullable: true
    },
    capabilities_summary: {
      type: "string",
      description: "用少于50个字总结该 Agent 的核心能力"
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "提取3个技术标签，例如 ['LLM', 'Vision', 'Crypto']"
    }
  },
  required: ["valid", "agent_name", "capabilities_summary", "tags"],
};

/**
 * 分析社交媒体文本并提取 Agent 节点信息
 * @param {string} rawText - 来自 X/Twitter 的原始推文
 */
export async function parseAgentFromText(rawText) {
  try {
    // 生成缓存键
    const cacheKey = `agent_parser:${rawText.trim().substring(0, 100)}`;
    
    // 检查缓存
    const cachedResult = await cacheService.get(cacheKey);
    if (cachedResult) {
      logger.debug('Parser cache hit', { cacheKey });
      return cachedResult;
    }

    const prompt = `
      You are the core topological parser for the XClaw AI Network.
      Analyze the following social media text and extract the AI Agent's profile.
      If it's just a general discussion without a specific agent, set valid to false.
      
      Raw Text:
      "${rawText}"
      
      Please return a JSON object with the following structure:
      {
        "valid": boolean,
        "agent_name": string or null,
        "capabilities_summary": string,
        "tags": array of strings
      }
    `;

    const responseText = await generateText(prompt, { responseSchema: agentSchema });
    
    // 此时可以直接安全地 parse，因为模型被强制限制了输出结构
    const agentData = JSON.parse(responseText);
    
    // 缓存结果
    await cacheService.set(cacheKey, agentData);
    
    logger.info('Agent parsed successfully', { valid: agentData.valid, agentName: agentData.agent_name });
    return agentData;

  } catch (error) {
    logger.error('Failed to parse agent from text', { error: error.message, stack: error.stack });
    // 生产环境中这里应接入 Sentry 或日志告警
    return { valid: false, error: error.message };
  }
}
