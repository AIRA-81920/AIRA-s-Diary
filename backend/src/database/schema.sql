-- AIRA's Diary 数据库 Schema
-- 完整表定义，全部使用 CREATE TABLE IF NOT EXISTS 保证幂等
-- 参考 PROJECT_README.md 模块二 2.3 节
--
-- M3 变更：
--   1. clarify_results 重命名为 crystallize_results，新增 inspiration_type / crystal_type 字段
--   2. 新增 epitaxy_proposals / epitaxy_fragments / knowledge_chunks
--   3. 新增 coalesce_candidates / coalesce_bridges
--   4. inspirations 表新增 crystal_type / inspiration_type 字段（通过迁移 v2 添加）

-- 灵感主表：存储用户的核心灵感记录
CREATE TABLE IF NOT EXISTS inspirations (
  id TEXT PRIMARY KEY,           -- UUID v4，主键
  title TEXT NOT NULL,            -- 灵感标题（必填）
  content TEXT,                  -- 灵感正文内容
  summary TEXT,                  -- AI 生成的摘要
  source_type TEXT,              -- 来源类型：'web' | 'file' | 'manual'
  source_url TEXT,               -- 来源链接（若为 web 采集）
  created_at DATETIME,           -- 创建时间（ISO 字符串）
  updated_at DATETIME,           -- 更新时间（ISO 字符串）
  metadata TEXT,                 -- 额外元数据（JSON 字符串）
  inspiration_type TEXT,         -- 灵感类型（M3 新增，迁移 v2 添加）：产品想法/氛围画面/...
  crystal_type TEXT,             -- 结晶形态（M3 新增，迁移 v2 添加）：prd/scene_card/...
  folder_id TEXT,                -- 所属文件夹 ID（v8 新增），NULL 表示散灵感
  sort_order INTEGER DEFAULT 0,  -- 排序序号（v8 新增），越小越靠前
  source_files_json TEXT,        -- 新建灵感拖入的原文文件 JSON（v11 新增），格式 [{filename, original_name, size}]
  title_ai_generated INTEGER DEFAULT 0,    -- title 是否 AI 生成待确认（v11 新增）：0=用户手写/已接受，1=AI生成待确认，2=AI提炼失败，3=AI提炼中（v12）
  content_ai_generated INTEGER DEFAULT 0   -- content 是否 AI 生成待确认（v11 新增）：语义同上（0/1/2/3）
);

-- 标签表：存储所有可用标签
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增主键
  name TEXT UNIQUE NOT NULL,             -- 标签名（唯一）
  color TEXT                             -- 标签颜色（HEX 值）
);

-- 灵感-标签关联表：多对多关系
CREATE TABLE IF NOT EXISTS inspiration_tags (
  inspiration_id TEXT,           -- 关联灵感 ID
  tag_id INTEGER,                -- 关联标签 ID
  PRIMARY KEY (inspiration_id, tag_id)  -- 复合主键防止重复
);

-- 灵感-灵感语义关联表：存储向量相似度计算结果
CREATE TABLE IF NOT EXISTS links (
  inspiration_id TEXT,           -- 源灵感 ID
  related_id TEXT,               -- 关联灵感 ID
  score REAL,                    -- cosine 相似度，阈值 >= 0.5 时写入
  created_at DATETIME,           -- 创建时间
  PRIMARY KEY (inspiration_id, related_id)  -- 复合主键
);

-- AI 聊天历史表：存储与 AI 的对话记录
CREATE TABLE IF NOT EXISTS chat_history (
  id TEXT PRIMARY KEY,           -- 消息 ID（UUID）
  session_id TEXT,               -- 会话 ID（同一对话归为一组）
  role TEXT,                     -- 角色：'user' | 'assistant'
  content TEXT,                  -- 消息内容
  created_at DATETIME            -- 创建时间
);

-- 系统设置表：键值对存储全局配置（如 API Key）
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,           -- 设置项名（主键）
  value TEXT                     -- 设置项值
);

-- 语义关联分析结果表：存储完整的分析 JSON（含向量相似度 + AI 分析）
CREATE TABLE IF NOT EXISTS semantic_link_analysis (
  id TEXT PRIMARY KEY,           -- 分析记录 ID（UUID）
  inspiration_id TEXT,           -- 锚点灵感 ID
  result TEXT,                   -- JSON 字符串：{ vector_similarities, ai_analysis, ... }
  created_at DATETIME             -- 创建时间
);

-- ===== M3 新增表 =====

-- 结晶结果表（v0.4 → M3）：原 clarify_results，存储类型感知 + 定制化结晶结果
CREATE TABLE IF NOT EXISTS crystallize_results (
  id TEXT PRIMARY KEY,           -- 记录 ID（UUID）
  inspiration_id TEXT,           -- 关联灵感 ID
  inspiration_type TEXT,         -- 灵感类型：产品想法/氛围画面/设定世界观/...
  crystal_type TEXT,             -- 结晶形态：prd/scene_card/worldview/...
  auto_run INTEGER DEFAULT 1,    -- 是否自动分流到下一 Agent
  saved_at DATETIME              -- 保存时间
);

-- Epitaxy 方向提案表（M3 新增）：用户结晶完成后自动生成的 3-5 张方向卡片
CREATE TABLE IF NOT EXISTS epitaxy_proposals (
  id TEXT PRIMARY KEY,           -- 提案 ID（UUID）
  inspiration_id TEXT,           -- 关联灵感 ID
  direction TEXT,                -- 探究方向（标题）
  reasoning TEXT,                -- 为什么值得探究
  expected_yield TEXT,           -- 探究后会得到什么
  status TEXT DEFAULT 'pending', -- pending/selected/skipped/distilled
  created_at DATETIME            -- 创建时间
);

-- Epitaxy 研究笔记片段表（M3 新增）：每张方向卡片深挖后产生的 4-6 个片段
CREATE TABLE IF NOT EXISTS epitaxy_fragments (
  id TEXT PRIMARY KEY,           -- 片段 ID（UUID）
  inspiration_id TEXT,           -- 关联灵感 ID
  proposal_id TEXT,              -- 关联提案 ID
  fragment_type TEXT,            -- 片段类型：existing_case/concept/warning/blank
  title TEXT,                    -- 片段标题
  full_text TEXT,                -- 片段完整文本
  chunks_json TEXT,              -- JSON 数组：[{id, text, kind, subkind}]
  created_at DATETIME            -- 创建时间
);

-- 用户提炼的词块表（M3 新增）：用户从研究笔记中选词填空保留的词块
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id TEXT PRIMARY KEY,           -- 词块 ID（UUID）
  inspiration_id TEXT,           -- 关联灵感 ID
  fragment_id TEXT,              -- 来源片段 ID
  original_text TEXT,            -- LLM 原文
  chunk_text TEXT,               -- 用户编辑后的文本（初始 = LLM 原文）
  chunk_kind TEXT,               -- 词块类型：reference/technique/imagery/concept/warning/material
  chunk_subkind TEXT,            -- LLM 自由生成的细分（如"爵士钢琴家"）
  user_note TEXT,                -- 用户附加备注（可选）
  selected_at DATETIME           -- 用户选定时间
);

-- Coalesce 候选对表（M3 新增）：向量相似度计算结果
CREATE TABLE IF NOT EXISTS coalesce_candidates (
  id TEXT PRIMARY KEY,           -- 候选对 ID（UUID）
  inspiration_id_a TEXT,         -- 灵感 A ID
  inspiration_id_b TEXT,         -- 灵感 B ID
  chunk_id_a TEXT,               -- 词块 A ID（可空，若 chunk ↔ crystal）
  chunk_id_b TEXT,               -- 词块 B ID
  vector_score REAL,             -- 向量相似度分数
  status TEXT DEFAULT 'pending', -- pending/confirmed/dismissed
  created_at DATETIME            -- 创建时间
);

-- Coalesce 桥梁表（M3 新增）：LLM 深挖的桥梁（跨灵感连接）
CREATE TABLE IF NOT EXISTS coalesce_bridges (
  id TEXT PRIMARY KEY,           -- 桥梁 ID（UUID）
  candidate_id TEXT,             -- 关联候选对 ID
  inspiration_id TEXT,           -- 所属灵感 ID（双向桥梁各存一条）
  bridge_type TEXT,              -- 桥梁类型：imagery_isomorphism/structural_resonance/emotional_echo/technique_transfer/thematic_opposition
  connection TEXT,               -- 连接描述
  new_idea_seed TEXT,            -- 新想法种子（可一键转新灵感）
  saved_at DATETIME              -- 保存时间
);

-- 迁移记录表：追踪已应用的数据库迁移版本
CREATE TABLE IF NOT EXISTS __migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,    -- 自增主键
  version INTEGER UNIQUE NOT NULL,        -- 迁移版本号（唯一）
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,  -- 应用时间
  name TEXT                                -- 迁移名称
);

-- ===== K3 v3 新增表 =====

-- 灵感级语义指纹 + 向量表（K3 新增）
-- 功能：缓存 LLM 生成的语义指纹与对应 embedding 向量，避免重复 ONNX 推理（架构文档 §8.3）
-- 实现方式：每个灵感一行，embedding 为 384 维 float32 序列化 BLOB
CREATE TABLE IF NOT EXISTS inspiration_embeddings (
  inspiration_id TEXT PRIMARY KEY,           -- 主键；外键 → inspirations.id，级联删除
  embedding BLOB,                            -- 384 维 float32 序列化（可空，未算时为 null）
  fingerprint TEXT,                          -- LLM 生成的语义指纹（150-200 字，可空）
  fingerprint_model TEXT,                    -- 生成指纹的 LLM 模型名
  model_name TEXT,                           -- embedding 模型名（防维度漂移，R12）
  stale INTEGER DEFAULT 1,                   -- 1=需重算，0=有效（架构文档 §8.3 L6）
  fingerprint_updated_at DATETIME,           -- 指纹更新时间
  embedding_updated_at DATETIME              -- 向量更新时间
);

-- 词块向量表（K3 新增，本期仅写入，读取留给扩展）
-- 功能：每个 knowledge_chunk 的 384 维向量缓存
-- 实现方式：外键关联 knowledge_chunks.id，级联删除
CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunk_id TEXT PRIMARY KEY,                 -- 主键；外键 → knowledge_chunks.id，级联删除
  embedding BLOB,                            -- 384 维 float32 序列化
  model_name TEXT,                           -- embedding 模型名
  updated_at DATETIME                        -- 更新时间
);

-- 注意：coalesce_bridges 的字段追加（inspiration_b_id / reason / vector_score /
--       llm_score / status）由 v3 迁移通过 ALTER TABLE 完成，不在 schema.sql 中重建。
--       coalesce_candidates 的 chunk_id_a / chunk_id_b 字段标记为废弃（ADR-5），
--       物理列保留以便回滚，新代码不读写。

-- ===== v7 新增表：追加条目功能 =====
-- inspiration_addenda: 灵感追加主帖（文本+链接+图片），时间线日志的一等公民
-- addendum_comments: 追加主帖下的评论（纯文本），用户手写的成果沉淀
-- saved_ai_replies: 对话窗口中用户主动保存的 AI 回答，"待消化的中间态"

-- 追加主帖表：灵感级时间线日志
CREATE TABLE IF NOT EXISTS inspiration_addenda (
  id TEXT PRIMARY KEY,              -- UUID v4
  inspiration_id TEXT NOT NULL,     -- 关联灵感
  content TEXT NOT NULL,            -- 追加文本
  links_json TEXT,                  -- 链接数组 JSON，如 ["https://...", "https://..."]
  images_json TEXT,                 -- 图片数组 JSON（v11 语义升级为对象数组 [{filename, description, status}]，读取层兼容旧字符串数组）
  files_json TEXT,                  -- 追加的文本文件 JSON（v11 新增），格式 [{filename, original_name, size}]
  created_at DATETIME NOT NULL,     -- 创建时间，按此排序
  updated_at DATETIME,              -- 编辑时间（首次创建时为 NULL）
  FOREIGN KEY (inspiration_id) REFERENCES inspirations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_addenda_inspiration ON inspiration_addenda(inspiration_id, created_at);

-- 评论表：挂在追加主帖下的纯文本回应
CREATE TABLE IF NOT EXISTS addendum_comments (
  id TEXT PRIMARY KEY,
  addendum_id TEXT NOT NULL,        -- 关联追加主帖
  content TEXT NOT NULL,            -- 评论文本核心部分（纯文本，无链接图片）
  context TEXT,                     -- 评论文本展开/阐释部分（可空，用于折叠展示）
  created_at DATETIME NOT NULL,
  updated_at DATETIME,              -- 编辑时间（首次创建时为 NULL）
  FOREIGN KEY (addendum_id) REFERENCES inspiration_addenda(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_comments_addendum ON addendum_comments(addendum_id, created_at);

-- 已保存 AI 回答表：对话窗口中用户显式保存的问答对
CREATE TABLE IF NOT EXISTS saved_ai_replies (
  id TEXT PRIMARY KEY,
  addendum_id TEXT NOT NULL,        -- 关联追加主帖
  inspiration_id TEXT NOT NULL,     -- 冗余字段，便于"继续思考"全局列表查询
  question TEXT NOT NULL,           -- 用户当时问的问题
  answer TEXT NOT NULL,             -- AI 的完整回答（含 [CORE] 标签的原文）
  core TEXT,                        -- AI 回答的核心观点（[CORE] 标签内容，可空）
  context TEXT,                     -- AI 回答的阐释/展开部分（标签外的内容，可空）
  converted INTEGER NOT NULL DEFAULT 0,  -- v10：是否已转化为评论（0=未转化，1=已转化）
  saved_at DATETIME NOT NULL,       -- 保存时间
  FOREIGN KEY (addendum_id) REFERENCES inspiration_addenda(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_saved_replies_addendum ON saved_ai_replies(addendum_id, saved_at);
CREATE INDEX IF NOT EXISTS idx_saved_replies_inspiration ON saved_ai_replies(inspiration_id, saved_at);

-- ===== v8 新增表：文件夹分组功能 =====

-- 文件夹表：侧边栏灵感分组容器
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,              -- UUID v4
  name TEXT NOT NULL DEFAULT '未命名文件夹',  -- 文件夹名称
  color TEXT NOT NULL DEFAULT '#60a5fa',    -- 用户选定颜色（hex）
  sort_order INTEGER NOT NULL DEFAULT 0,    -- 侧边栏排序序号
  created_at DATETIME NOT NULL DEFAULT (datetime('now')),
  updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
);
