window.__ModuleLoader__.load({
  id: '@local/sourcelook',
  factory(require) {
    'use strict';
    const React = require('react');
    const h = React.createElement;
    const {
      Fragment,
      useCallback,
      useEffect,
      useLayoutEffect,
      useMemo,
      useRef,
      useState,
    } = React;

    const NS = 'sourcelook';
    const API = '/api/sourcelook';
    const BUILD_TAG = '2026-11-17-a7';
    /* SourceLook 插件自身的版本号（与 DSH 无关）；关于对话框显示它。 */
    const PLUGIN_VERSION = '1.5.111';
    const HEADER = 'x-sourcelook';

    const MODE_KEY = 'sourcelook.mode';
    const OPEN_MODE_KEY = 'sourcelook.openMode';
    const THEME_KEY = 'sourcelook.theme';
    const COLORS_KEY = 'sourcelook.colors';
    const FONT_SIZE_KEY = 'sourcelook.fontSize';
    const AI_KEY = 'sourcelook.ai';
    const PANES_KEY = 'sourcelook.panes';
    const AI_LOG_KEY = 'sourcelook.aiLog';
    const RECENT_PROJECTS_KEY = 'sourcelook.recentProjects';
    const LAST_POS_KEY = 'sourcelook.lastPos';
    const DSH_WIDTH_KEY = 'sourcelook.dshWidth.overlay';
    const SIDEBAR_WIDTH_KEY = 'sourcelook.sidebarWidth';
    const SIDEBAR_RATIO_KEY = 'sourcelook.sidebarRatio';
    const GLOBAL_WIDTH_KEY = 'sourcelook.globalWidth';
    const OUTLINE_HEIGHT_KEY = 'sourcelook.outlineHeight';
    const RESULTS_HEIGHT_KEY = 'sourcelook.cwHeight';
    const TABS_PREFIX = 'sourcelook.tabs:';
    const DRAFT_PREFIX = 'sourcelook.draft:';
    const RECENT_PREFIX = 'sourcelook.recent:';
    const DRAFT_LIMIT = 256 * 1024;
