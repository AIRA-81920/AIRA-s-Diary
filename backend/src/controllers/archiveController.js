// Archive 控制器（K3-d 新建）
// 功能：处理档案馆聚合接口 HTTP 请求
// 实现方式：调用 ArchiveService.getArchive，按 §9.2 返回 ArchiveResponse
//
// 端点：GET /api/inspirations/:id/archive → ArchiveResponse
// 错误：404 NOT_FOUND（灵感不存在）

import { ArchiveService } from '../services/archiveService.js';

/**
 * 获取灵感档案馆聚合数据
 * 功能：Detail 唯一数据源，徽章口径全部由此处出（§9.2，L4 防漂移）
 * @param {object} req - Express request（req.params.id 为灵感 ID）
 * @param {object} res - Express response
 */
export async function getArchive(req, res) {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'inspirationId is required',
        code: 'VALIDATION_FAILED'
      });
    }
    const archive = await ArchiveService.getArchive(id);
    if (!archive) {
      return res.status(404).json({
        success: false,
        error: 'Inspiration not found',
        code: 'NOT_FOUND'
      });
    }
    res.json({ success: true, data: archive });
  } catch (err) {
    console.error('[ArchiveController] getArchive error:', err.message);
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'INTERNAL_ERROR'
    });
  }
}
