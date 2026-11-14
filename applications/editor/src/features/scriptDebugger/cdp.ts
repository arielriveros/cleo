// The slice of the Chrome DevTools Protocol the script debugger uses, typed by hand (the full protocol
// typings are a large dependency for a dozen shapes). Field names as the protocol has them.

export interface CdpLocation {
  scriptId: string;
  /** 0-based. */
  lineNumber: number;
  /** 0-based. */
  columnNumber?: number;
}

export interface CdpPropertyPreview {
  name: string;
  type: string;
  subtype?: string;
  value?: string;
}

export interface CdpObjectPreview {
  type: string;
  subtype?: string;
  description?: string;
  overflow: boolean;
  properties: CdpPropertyPreview[];
}

export interface CdpRemoteObject {
  type: 'object' | 'function' | 'undefined' | 'string' | 'number' | 'boolean' | 'symbol' | 'bigint';
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
  preview?: CdpObjectPreview;
}

export interface CdpScope {
  type: 'global' | 'local' | 'with' | 'closure' | 'catch' | 'block' | 'script' | 'eval' | 'module' | 'wasm-expression-stack';
  object: CdpRemoteObject;
  name?: string;
}

export interface CdpCallFrame {
  callFrameId: string;
  functionName: string;
  location: CdpLocation;
  /** Deprecated and empty for eval'd scripts: resolve the URL from the scriptId (scriptParsed). */
  url: string;
  scopeChain: CdpScope[];
  this: CdpRemoteObject;
  returnValue?: CdpRemoteObject;
}

export interface CdpPausedEvent {
  callFrames: CdpCallFrame[];
  reason: string;
  /** For an exception: the thrown value, as a remote object. */
  data?: CdpRemoteObject & { uncaught?: boolean };
  hitBreakpoints?: string[];
}

export interface CdpScriptParsed {
  scriptId: string;
  url: string;
  hash?: string;
}

export interface CdpPropertyDescriptor {
  name: string;
  value?: CdpRemoteObject;
  get?: CdpRemoteObject;
  set?: CdpRemoteObject;
  writable?: boolean;
  configurable: boolean;
  enumerable: boolean;
  isOwn?: boolean;
}

export interface CdpExceptionDetails {
  text: string;
  exception?: CdpRemoteObject;
}

/** What an evaluation answers: a value, or what it threw. */
export interface CdpEvaluateResult {
  result: CdpRemoteObject;
  exceptionDetails?: CdpExceptionDetails;
}

/** A one-line text for a remote value, as the variables panel and hover show it. */
export function describeRemote(object: CdpRemoteObject | undefined): string {
  if (!object) return 'undefined';
  switch (object.type) {
    case 'undefined': return 'undefined';
    case 'string': return JSON.stringify(object.value);
    case 'number': case 'boolean': return object.unserializableValue ?? String(object.value);
    case 'bigint': return object.unserializableValue ?? `${object.description ?? ''}`;
    case 'symbol': return object.description ?? 'Symbol()';
    case 'function': return `ƒ ${(object.description ?? '').split('\n')[0].replace(/\s*\{$/, '').slice(0, 80)}`;
  }
  if (object.subtype === 'null') return 'null';
  const preview = object.preview;
  if (preview && preview.properties?.length) {
    const inner = preview.properties.slice(0, 6).map(p => (object.subtype === 'array' ? p.value ?? p.type : `${p.name}: ${p.value ?? p.type}`)).join(', ');
    const more = preview.overflow || preview.properties.length > 6 ? ', …' : '';
    return object.subtype === 'array' ? `${object.description ?? 'Array'} [${inner}${more}]` : `${object.className ?? 'Object'} {${inner}${more}}`;
  }
  return object.description ?? object.className ?? 'Object';
}

/** Whether a remote value has children to expand. */
export function isExpandable(object: CdpRemoteObject | undefined): boolean {
  return !!object?.objectId && object.type === 'object' && object.subtype !== 'null';
}
