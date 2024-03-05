import { CleoEngine } from "./engine";

interface Log {
  type: 'log' | 'info' | 'warning' | 'error';
  scope: string;
  message: string;
  timeStamp: string;
}

export class Logger {
  private static _instance: Logger | null = null;
  private _logs: Log[];

  private constructor() {
    this._logs = [];
  }

  public static get Instance(): Logger {
    if (!Logger._instance) {
      Logger._instance = new Logger();
    }
    return Logger._instance;
  }

  public static get logs() {
    return Logger.Instance._logs;
  }

  private static logInternal(type: Log['type'], message: string, scope: string = 'Runtime') {
    
    switch (type) {
      case 'log':
        console.log(`[${scope}] ${message}`);
        break;
      case 'info':
        console.info(`[${scope}] ${message}`);
        break;
      case 'warning':
        console.warn(`[${scope}] ${message}`);
        break;
      case 'error':
        console.error(`[${scope}] ${message}`);
        break;
    }

    // get current hh:mm:ss:ms without date
    const timeStamp = new Date().toTimeString().split(' ')[0];
    const log: Log = { type, scope, message, timeStamp };
    Logger.logs.push(log);

    CleoEngine.eventEmitter.emit('LOG', log);
  }

  public static log(message: string, scope: string = 'Runtime') {
    Logger.logInternal('log', message, scope);
  }

  public static info(message: string, scope: string = 'Runtime') {
    Logger.logInternal('info', message, scope);
  }

  public static warn(message: string, scope: string = 'Runtime') {
    Logger.logInternal('warning', message, scope);
  }

  public static error(message: string, scope: string = 'Runtime') {
    Logger.logInternal('error', message, scope);
  }

  public static clear() {
    Logger.Instance._logs = [];
  }
}
