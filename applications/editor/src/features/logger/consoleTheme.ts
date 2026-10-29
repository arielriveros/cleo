// console-feed's <Console> is themed through a flat `styles` object, filled from the index.css design
// tokens. Must be read lazily, not at module init: style-loader injects index.css after this module's
// import is evaluated.
import { token as color } from '../../utils/cssTokens';

type ConsoleStyles = Record<string, any>;

let cached: ConsoleStyles | null = null;

export function getConsoleStyles(): ConsoleStyles {
  if (cached) return cached;

  const text = color('--text');
  const muted = color('--text-muted');
  const border = color('--border-subtle');
  const warning = color('--warning');
  const danger = color('--danger');
  const highlight = color('--highlight');

  cached = {
    BASE_FONT_FAMILY: 'Consolas, monaco, monospace',
    BASE_FONT_SIZE: '12px',
    BASE_LINE_HEIGHT: '16px',
    BASE_BACKGROUND_COLOR: 'transparent', // the panel owns the background
    BASE_COLOR: text,
    PADDING: '0px',

    LOG_COLOR: text,
    LOG_BACKGROUND: 'transparent',
    LOG_BORDER: border,
    LOG_ICON_WIDTH: '10px',
    LOG_ICON_HEIGHT: '10px',

    LOG_INFO_COLOR: highlight,
    LOG_INFO_BACKGROUND: 'transparent',
    LOG_INFO_BORDER: border,

    LOG_WARN_COLOR: warning,
    LOG_WARN_BACKGROUND: color('--warning', 0.08),
    LOG_WARN_BORDER: color('--warning', 0.3),

    LOG_ERROR_COLOR: danger,
    LOG_ERROR_BACKGROUND: color('--danger', 0.1),
    LOG_ERROR_BORDER: color('--danger', 0.35),

    // Object inspector (react-inspector) — keep it close to Chrome devtools' dark palette.
    OBJECT_NAME_COLOR: highlight,
    OBJECT_VALUE_NULL_COLOR: muted,
    OBJECT_VALUE_UNDEFINED_COLOR: muted,
    OBJECT_VALUE_STRING_COLOR: '#e3a869',
    OBJECT_VALUE_NUMBER_COLOR: '#9980ff',
    OBJECT_VALUE_BOOLEAN_COLOR: '#9980ff',
    OBJECT_VALUE_REGEXP_COLOR: danger,
    OBJECT_VALUE_SYMBOL_COLOR: '#e3a869',
    OBJECT_VALUE_FUNCTION_KEYWORD_COLOR: highlight,
    ARROW_COLOR: muted,
    TREENODE_FONT_FAMILY: 'Consolas, monaco, monospace',
    TREENODE_FONT_SIZE: '12px',
    TREENODE_LINE_HEIGHT: '16px',
  };

  return cached;
}
