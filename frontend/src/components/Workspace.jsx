// Workspace 主工作区组件（K3-e + K4-b + fix5-3 改造：统一 ResizablePanel 实现平滑动画）
// 功能：组合 Header / Sidebar / InspirationDetail / WorkbenchDrawer / InspirationModal / ForceGraph
// 实现方式：
//   - fix5-3：始终用同一个 ResizablePanel 包裹 Sidebar，不再条件渲染切换
//     这样挤压态↔展开态切换时 width 属性变化触发 transition，有平滑动画
//   - 挤压态：width=sidebarCompressedWidth(80)，允许拖拽调整 [80, 240]
//   - 展开态：width=sidebarWidth(280)，允许拖拽调整 [200, 380]
//   - Sidebar 的 compressed prop 控制 UI 显示（图标模式 vs 完整列表）
//   - Detail 始终渲染，抽屉与 Detail 并列（挤压式，不替换 Detail）
import React, { useCallback } from 'react'
import useStore from '../services/store.js'
import Header from './Header.jsx'
import Sidebar from './Sidebar.jsx'
import InspirationDetail from './InspirationDetail.jsx'
import InspirationModal from './InspirationModal.jsx'
import FolderEditModal from './FolderEditModal.jsx'
import ResizablePanel from './ResizablePanel.jsx'
import WorkbenchDrawer from './WorkbenchDrawer.jsx'
import ConversationDrawer from './ConversationDrawer.jsx'
import ForceGraph from './ForceGraph.jsx'
import ContinueThinkingPanel from './ContinueThinkingPanel.jsx'
import SettingsPanel from './SettingsPanel.jsx'

function Workspace() {
  // 从 store 获取状态
  const inspirations = useStore((state) => state.inspirations)
  const selectedInspiration = useStore((state) => state.selectedInspiration)
  const searchQuery = useStore((state) => state.searchQuery)
  const isModalOpen = useStore((state) => state.isModalOpen)
  const editingInspiration = useStore((state) => state.editingInspiration)
  // v8：文件夹状态
  const folders = useStore((state) => state.folders)
  const folderExpanded = useStore((state) => state.folderExpanded)
  const folderEditModal = useStore((state) => state.folderEditModal)

  // 布局状态：Sidebar 宽度（展开态用）
  const sidebarWidth = useStore((state) => state.sidebarWidth)
  const sidebarWidthMin = useStore((state) => state.sidebarWidthMin)
  const sidebarWidthMax = useStore((state) => state.sidebarWidthMax)

  // fix5-3：挤压态宽度（独立于展开态）
  const sidebarCompressedWidth = useStore((state) => state.sidebarCompressedWidth)
  const sidebarCompressedWidthMin = useStore((state) => state.sidebarCompressedWidthMin)
  const sidebarCompressedWidthMax = useStore((state) => state.sidebarCompressedWidthMax)

  // K3-e + K4-b：抽屉状态 + Sidebar 挤压态
  const drawer = useStore((state) => state.drawer)
  const sidebarCompressed = useStore((state) => state.sidebarCompressed)
  // 对话探究抽屉：当前对话的追加条目 ID（用于 key 强制重建）
  const conversationAddendumId = useStore((state) => state.conversationAddendumId)
  // 继续思考面板：是否显示
  const showContinueThinking = useStore((state) => state.showContinueThinking)

  // 从 store 获取 actions
  const setSelectedInspiration = useStore((state) => state.setSelectedInspiration)
  const setSearchQuery = useStore((state) => state.setSearchQuery)
  const openModal = useStore((state) => state.openModal)
  const closeModal = useStore((state) => state.closeModal)
  const createInspiration = useStore((state) => state.createInspiration)
  const updateInspiration = useStore((state) => state.updateInspiration)
  const deleteInspiration = useStore((state) => state.deleteInspiration)
  const setSidebarWidth = useStore((state) => state.setSidebarWidth)
  const setSidebarCompressedWidth = useStore((state) => state.setSidebarCompressedWidth)
  // v8：文件夹 actions
  const toggleFolderExpanded = useStore((state) => state.toggleFolderExpanded)
  const openFolderEdit = useStore((state) => state.openFolderEdit)
  const moveInspirationToFolder = useStore((state) => state.moveInspirationToFolder)
  const reorderItems = useStore((state) => state.reorderItems)
  const createFolderFromMerge = useStore((state) => state.createFolderFromMerge)

  /**
   * 保存回调：编辑模式调用 updateInspiration，新建模式调用 createInspiration
   */
  const handleSave = useCallback(
    (data) => {
      if (editingInspiration) {
        updateInspiration(editingInspiration.id, data)
      } else {
        createInspiration(data)
      }
    },
    [editingInspiration, updateInspiration, createInspiration]
  )

  /**
   * 取消选中灵感：回到初始空状态
   */
  const handleDeselect = useCallback(() => {
    setSelectedInspiration(null)
  }, [setSelectedInspiration])

  // fix5-3：根据挤压态选择当前 width/min/max/onResize
  // 始终用同一个 ResizablePanel，切换挤压态时 width 属性变化触发 transition
  const currentSidebarWidth = sidebarCompressed ? sidebarCompressedWidth : sidebarWidth
  const currentSidebarMin = sidebarCompressed ? sidebarCompressedWidthMin : sidebarWidthMin
  const currentSidebarMax = sidebarCompressed ? sidebarCompressedWidthMax : sidebarWidthMax
  const currentSidebarResize = sidebarCompressed ? setSidebarCompressedWidth : setSidebarWidth

  return (
    // 整体布局：纵向 flex 撑满屏幕高度
    <div className="flex flex-col h-screen">
      {/* 顶部导航：新建按钮打开弹窗（新建模式） */}
      <Header onNewInspiration={() => openModal(null)} />

      {/* 下方区域：横向 flex，Sidebar + Detail + (可选)WorkbenchDrawer
          fix5-3：统一 ResizablePanel，挤压态↔展开态切换有 width transition 动画 */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* fix5-3：始终用同一个 ResizablePanel，不再条件渲染切换
            挤压态和展开态都能拖拽调整宽度，切换时有平滑动画 */}
        <ResizablePanel
          width={currentSidebarWidth}
          minWidth={currentSidebarMin}
          maxWidth={currentSidebarMax}
          onResize={currentSidebarResize}
          side="right"
        >
          <Sidebar
            inspirations={inspirations}
            folders={folders}
            folderExpanded={folderExpanded}
            selectedInspiration={selectedInspiration}
            searchQuery={searchQuery}
            onSelectInspiration={setSelectedInspiration}
            onSearchChange={setSearchQuery}
            onToggleFolderExpanded={toggleFolderExpanded}
            onEditFolder={openFolderEdit}
            onMoveInspiration={moveInspirationToFolder}
            onReorderItems={reorderItems}
            onCreateFolder={createFolderFromMerge}
            onRenameInspiration={(id, title) => updateInspiration(id, { title })}
            compressed={sidebarCompressed}
            onNewInspiration={() => openModal(null)}
          />
        </ResizablePanel>

        {/* K4-b：Detail 始终渲染（挤压式），抽屉打开时 Detail 显示外延联动视图 */}
        <InspirationDetail
          key={`detail-${selectedInspiration?.id || 'empty'}`}
          inspiration={selectedInspiration}
          onEdit={() => openModal(selectedInspiration)}
          onDelete={() => deleteInspiration(selectedInspiration.id)}
          onDeselect={handleDeselect}
        />

        {/* K4-b：抽屉与 Detail 并列（挤压式），仅 crystallize/epitaxy 时显示 WorkbenchDrawer */}
        {(drawer === 'crystallize' || drawer === 'epitaxy') && selectedInspiration && (
          <WorkbenchDrawer key={`drawer-${selectedInspiration.id}-${drawer}`} />
        )}

        {/* 对话探究抽屉：drawer === 'conversation' 时渲染（与 WorkbenchDrawer 互斥） */}
        {drawer === 'conversation' && selectedInspiration && (
          <ConversationDrawer key={`conv-${selectedInspiration.id}-${conversationAddendumId}`} />
        )}
      </div>

      {/* 条件渲染：弹窗打开时显示 */}
      {isModalOpen && (
        <InspirationModal
          inspiration={editingInspiration}
          onSave={handleSave}
          onClose={closeModal}
        />
      )}

      {/* K3-f：ForceGraph 全屏覆盖层（Layer 2，z-index 最高）
          打开时 Layer 1 冻结不卸载，关闭后状态保留 */}
      <ForceGraph />

      {/* 继续思考面板：showContinueThinking 时全屏显示已保存对话卡片 */}
      {showContinueThinking && <ContinueThinkingPanel />}

      {/* 设置面板：毛玻璃浮窗，从画面中央推入 */}
      <SettingsPanel />

      {/* v8：文件夹编辑弹窗 */}
      {folderEditModal && <FolderEditModal />}
    </div>
  )
}

export default Workspace
