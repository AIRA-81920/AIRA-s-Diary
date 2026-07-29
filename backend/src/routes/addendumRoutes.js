// 追加条目路由（v7 新增）
// 功能：挂载追加主帖 / 评论 / 已保存 AI 回答 / 图片上传 / 对话 的 HTTP 端点
// 实现方式：express.Router + 控制器方法绑定，参考 crystallizeRoutes.js 写法
//
// 路由注册顺序约束：
//   1. 静态路径必须先于参数路径注册，避免 Express 路由匹配误判
//      （例如 /addenda/saved-replies 必须先于 /addenda/:addendumId）
//   2. 同前缀的 GET/POST/PUT/DELETE 按业务顺序排列

import express from 'express';
import * as ctrl from '../controllers/addendumController.js';
import * as convCtrl from '../controllers/conversationController.js';

const router = express.Router();

// ===== 静态路径（先注册，避免被 /addenda/:addendumId 抢匹配） =====

// 全局"继续思考"列表：所有已保存的 AI 回答
router.get('/addenda/saved-replies', ctrl.listAllSavedReplies);

// 图片上传（multipart/form-data，字段名 image）
router.post('/addenda/upload-image', ctrl.upload.single('image'), ctrl.uploadImage);

// ===== 追加主帖 CRUD =====

// 列出某灵感的所有追加主帖（含评论与已保存 AI 回答的嵌套结构）
router.get('/inspirations/:id/addenda', ctrl.listAddenda);

// 创建追加主帖
router.post('/inspirations/:id/addenda', ctrl.createAddendum);

// 更新追加主帖
router.put('/addenda/:addendumId', ctrl.updateAddendum);

// 删除追加主帖（级联删除评论与已保存回答）
router.delete('/addenda/:addendumId', ctrl.deleteAddendum);

// ===== 评论 CRUD =====

// 在某追加主帖下创建评论
router.post('/inspirations/:id/addenda/:addendumId/comments', ctrl.createComment);

// 更新评论
router.put('/comments/:commentId', ctrl.updateComment);

// 删除评论
router.delete('/comments/:commentId', ctrl.deleteComment);

// ===== 已保存 AI 回答 CRUD =====

// 保存某次对话的 AI 回答
router.post('/inspirations/:id/addenda/:addendumId/replies', ctrl.saveReply);

// 删除已保存的 AI 回答
router.delete('/replies/:replyId', ctrl.deleteReply);

// ===== 对话端点 =====

// 在某追加主帖下发起对话（向 AI 提问）
router.post('/inspirations/:id/addenda/:addendumId/conversation', convCtrl.ask);
// 流式对话（SSE）：与上面同一端点，路径加 /stream，返回 text/event-stream
router.post('/inspirations/:id/addenda/:addendumId/conversation/stream', convCtrl.askStream);

export default router;
