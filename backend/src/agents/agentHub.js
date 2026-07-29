// AgentHub 统一调度中心
// 功能：单例模式管理所有 Agent，提供 dispatch 和 listAgents 接口
// 实现方式：AGENT_REGISTRY 注册 Agent 类，dispatch 时实例化并调用 run
//
// M3 变更：原 clarify 注册项 → crystallize；新增 epitaxy / coalesce 占位（M3-c / M3-e 实现具体 Agent）
// 图标：crystallize 用 💎（结晶），epitaxy 用 🌱（外延生长），coalesce 用 🌌（融合）

import CrystallizeAgent from './crystallizeAgent.js';
import EpitaxyAgent from './epitaxyAgent.js';
import CoalesceAgent from './coalesceAgent.js';

// Agent 注册表
// key 为 agentType（与 AGENT_TYPES 枚举值一致），value 为元数据
// M3-e：注册 coalesce
const AGENT_REGISTRY = {
  crystallize: {
    class: CrystallizeAgent,
    name: 'CrystallizeAgent',
    icon: '💎',
    description: '感知类型 → 定制化追问 → 生成结晶体'
  },
  epitaxy: {
    class: EpitaxyAgent,
    name: 'EpitaxyAgent',
    icon: '🌱',
    description: '方向提案 → 深挖笔记 → 选词提炼'
  },
  coalesce: {
    class: CoalesceAgent,
    name: 'CoalesceAgent',
    icon: '🔗',
    description: '跨灵感桥梁 → 新灵感种子'
  }
};

class AgentHub {
  constructor() {
    // 单例实例缓存（按 agentType 缓存，避免重复实例化）
    this.instances = new Map();
  }

  // 调度 Agent
  // 功能：根据 agentType 查找并执行 Agent
  // 实现方式：查 AGENT_REGISTRY → 单例缓存 → 调用 agent.run(context)
  async dispatch(agentType, context) {
    const config = AGENT_REGISTRY[agentType];
    // 未知 agentType 返回错误对象（不抛异常）
    // M3-a 阶段：若 CrystallizeAgent 自动分流到 epitaxy，会走到此分支（epitaxy 尚未注册）
    if (!config) {
      return { success: false, error: `Unknown agent type: ${agentType}` };
    }
    try {
      // 单例缓存：同一 agentType 复用实例
      if (!this.instances.has(agentType)) {
        this.instances.set(agentType, new config.class());
      }
      const agent = this.instances.get(agentType);
      return await agent.run(context);
    } catch (error) {
      // Agent 执行异常时返回错误对象（不抛异常，由调用方处理）
      console.error(`[AgentHub] dispatch ${agentType} failed:`, error);
      return { success: false, error: error.message };
    }
  }

  // 列出所有 Agent 元数据
  // 功能：返回注册表中所有 Agent 的 type/name/icon/description
  // 实现方式：Object.entries 遍历 AGENT_REGISTRY
  listAgents() {
    return Object.entries(AGENT_REGISTRY).map(([type, config]) => ({
      type,
      name: config.name,
      icon: config.icon,
      description: config.description
    }));
  }
}

// 导出单例（全应用共享同一 AgentHub 实例）
const agentHub = new AgentHub();
export default agentHub;
