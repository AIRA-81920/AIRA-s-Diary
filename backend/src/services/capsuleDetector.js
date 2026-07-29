// CapsuleDetector — 设定胶囊识别服务（K4 新建）
// 功能：扫描灵感文本，识别 AESTHETIC_CAPSULES 中的关键词
// 实现方式：遍历字典，对 aliases 做大小写不敏感匹配
//
// 契约（架构文档 §10.7）：
//   interface CapsuleDetector {
//     detectCapsules(content: string, inspirationType: string): {
//       detected: boolean,
//       capsules: Array<{
//         key: string,
//         name: string,
//         pack_type: string,
//         elements: object,
//         applicable_elements: string[]
//       }>
//     }
//   }
//
// 关键约束：
//   - 仅识别显式关键词，不主动推断
//   - 多胶囊叠加返回数组
//   - applicable_elements 按 CAPSULE_TYPE_MAP 取用

import { AESTHETIC_CAPSULES, CAPSULE_TYPE_MAP } from '../config/constants.js';

/**
 * CapsuleDetector 单例对象
 * 设计原则：所有方法静态化（无 this 状态），状态由 constants.js 承载
 */
export const CapsuleDetector = {
  /**
   * 识别灵感文本中的设定胶囊
   * 功能：遍历 AESTHETIC_CAPSULES 字典，对每个胶囊的 aliases 做大小写不敏感匹配
   * 实现方式：
   *   1. content 转小写
   *   2. 遍历 AESTHETIC_CAPSULES，对每个胶囊的 aliases 做 includes 匹配
   *   3. 匹配到则加入结果数组（按 CAPSULE_TYPE_MAP 取用 applicable_elements）
   *   4. 返回 { detected, capsules }
   * @param {string} content - 灵感文本
   * @param {string} inspirationType - 灵感类型（用于取用 applicable_elements）
   * @returns {{ detected: boolean, capsules: Array }}
   */
  detectCapsules(content, inspirationType) {
    // 输入校验：空内容或非字符串直接返回空结果
    if (!content || typeof content !== 'string') {
      return { detected: false, capsules: [] };
    }

    const contentLower = content.toLowerCase();
    const matched = [];

    // 遍历胶囊字典，对每个胶囊的 aliases 做大小写不敏感匹配
    for (const [key, capsule] of Object.entries(AESTHETIC_CAPSULES)) {
      for (const alias of capsule.aliases) {
        if (contentLower.includes(alias.toLowerCase())) {
          matched.push({
            key,
            name: capsule.name,
            pack_type: capsule.pack_type,
            elements: capsule.elements,
            // applicable_elements 按 CAPSULE_TYPE_MAP 取用，未匹配到则空数组
            applicable_elements: CAPSULE_TYPE_MAP[inspirationType] || []
          });
          break;  // 一个胶囊只匹配一次，避免重复入队
        }
      }
    }

    return {
      detected: matched.length > 0,
      capsules: matched
    };
  }
};

export default CapsuleDetector;
