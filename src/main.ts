// The entry point: no module wires itself up on import, so every install…() is called here, in order.
import './styles.css';
import { migrateLegacyKeys } from './utils/legacy-keys.js';
import { installMotionSwitch } from './utils/motion.js';
import { keys, installSafeInsets } from './utils/dom.js';
import { installGrid, onGridChanged } from './view/grid.js';
import { installInk } from './view/color.js';
import { mountIcons } from './view/icons.js';
import { onViewApplied } from './view/camera.js';
import { installDataHooks } from './data/hooks.js';
import { scheduleSaveBoard } from './data/board.js';
import { installSaveOnLeave } from './data/save.js';
import { installSaveAlert } from './data/save-alert.js';
import { installImportPicker } from './data/zip-io.js';
import { paintNode, remeasure, flashArrived } from './render.js';
import { installClickCount } from './features/activate.js';
import { installGestures } from './features/gestures.js';
import { installAttachments } from './features/attachments.js';
import { installOpenDrop } from './features/open-drop.js';
import { installLaunch } from './features/launch.js';
import { installUpdateCheck } from './features/update.js';
import { installTextDrag } from './features/text-drag.js';
import { installContextMenu } from './features/context-menu.js';
import { installGhostCard } from './features/ghost-card.js';
import { installCommands } from './features/commands.js';
import { installEdgeBar } from './features/edge-bar.js';
import { installEdgeTools } from './features/edge-tools.js';
import { installComplete } from './features/complete.js';
import { installTagPicker } from './features/tag-picker.js';
import { installPalette } from './features/palette.js';
import { installBreadcrumbs, paintMapCrumb } from './features/breadcrumbs.js';
import { installInlineEdit } from './features/inline-edit.js';
import { installDragModifiers } from './features/drag.js';
import { installStacks } from './features/stacks.js';
import { installSearch, searchHolds } from './features/search.js';
import { syncFloatBar, installFloatBar } from './features/float-bar.js';
import { installCanvasColor } from './features/canvas-color.js';
import { restoreTray, installTagTray } from './features/tag-tray.js';
import { installPeek } from './features/peek.js';
import { clearHistory, historyRefs } from './features/history.js';
import { selectNode } from './features/selection.js';
import { updateDocumentTitle, scheduleUrlSync, installUrlState } from './nav/url-state.js';
import { installScopeResize } from './nav/sections.js';
import { hideStart, boot, installStartScreen } from './boot.js';

migrateLegacyKeys();   // FIRST: before anything reads a setting
installSaveOnLeave();
installSaveAlert();
installImportPicker();
installMotionSwitch();
installSafeInsets();
installInk();
installEdgeBar();
installStacks();
installDragModifiers();
installTextDrag();
installContextMenu();
installFloatBar();
installTagPicker();
installSearch();
installUrlState();
installBreadcrumbs();
installScopeResize();
installAttachments();
installComplete();
installInlineEdit();
installGestures();
installStartScreen();
installOpenDrop();
installLaunch();
installUpdateCheck();
installGhostCard();
installPalette();
installTagTray();
installCommands();

// After every install above, so their markup gets the platform's shortcut spelling and icons too.
document.querySelectorAll<HTMLElement>('[title]').forEach(el => { el.title = keys(el.title); });
mountIcons();
installGrid();
installCanvasColor();

onViewApplied(scheduleUrlSync);
onGridChanged(scheduleSaveBoard);

// Function declarations only: hoisted, so no TDZ.
installDataHooks({
  paintNode,
  remeasure,
  forgetHistory: clearHistory,
  historyRefs,
  searchHolds,
  showMapName() {
    paintMapCrumb();
    updateDocumentTitle();
  },
  leaveHome: hideStart,
  reloaded(selId, arrived) {
    selectNode(selId);
    flashArrived(arrived);
  },
});

installClickCount();
syncFloatBar();
installEdgeTools();   // its grabs are claimed ahead of card-drag and canvas-pan
installPeek();
restoreTray();

boot();

// The offline copy (public/sw.js), for the built app only.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* file://, or a browser that refuses: the app works without */ });
}

