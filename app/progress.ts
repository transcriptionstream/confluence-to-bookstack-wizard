import { EventEmitter } from 'events';
import { ServerResponse } from 'http';

export interface ProgressData {
  phase: string;
  message: string;
  current?: number;
  total?: number;
  percent?: number;
  counters?: Record<string, number>;
  level?: 'info' | 'success' | 'warning' | 'error';
}

export class ProgressReporter extends EventEmitter {
  start(data: ProgressData): void {
    this.emit('start', { ...data, level: data.level || 'info' });
  }

  progress(data: ProgressData): void {
    this.emit('progress', { ...data, level: data.level || 'info' });
  }

  success(data: ProgressData): void {
    this.emit('success', { ...data, level: 'success' });
  }

  error(data: ProgressData): void {
    this.emit('error', { ...data, level: 'error' });
  }

  warning(data: ProgressData): void {
    this.emit('warning', { ...data, level: 'warning' });
  }

  complete(data: ProgressData): void {
    this.emit('complete', { ...data, level: 'success' });
  }

  log(phase: string, message: string, level: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
    this.emit('log', { phase, message, level });
  }
}

// ANSI color codes for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

export function createConsoleReporter(): ProgressReporter {
  const reporter = new ProgressReporter();

  reporter.on('start', (data: ProgressData) => {
    console.log(`${colors.yellow}[${data.phase}] Starting: ${data.message}${colors.reset}`);
  });

  reporter.on('progress', (data: ProgressData) => {
    let msg = `[${data.phase}] ${data.message}`;
    if (data.current !== undefined && data.total !== undefined) {
      msg += ` (${data.current}/${data.total})`;
    }
    const color = data.level === 'error' ? colors.red :
      data.level === 'warning' ? colors.yellow :
        data.level === 'success' ? colors.green : '';
    console.log(`${color}${msg}${colors.reset}`);
  });

  reporter.on('success', (data: ProgressData) => {
    console.log(`${colors.green}[${data.phase}] ${data.message}${colors.reset}`);
  });

  reporter.on('error', (data: ProgressData) => {
    console.log(`${colors.red}[${data.phase}] ${data.message}${colors.reset}`);
  });

  reporter.on('warning', (data: ProgressData) => {
    console.log(`${colors.yellow}[${data.phase}] ${data.message}${colors.reset}`);
  });

  reporter.on('complete', (data: ProgressData) => {
    console.log(`${colors.green}[${data.phase}] Complete: ${data.message}${colors.reset}`);
    if (data.counters) {
      for (const [key, value] of Object.entries(data.counters)) {
        console.log(`  ${colors.cyan}${key}: ${value}${colors.reset}`);
      }
    }
  });

  reporter.on('log', (data: { phase: string; message: string; level: string }) => {
    const color = data.level === 'error' ? colors.red :
      data.level === 'warning' ? colors.yellow :
        data.level === 'success' ? colors.green : colors.dim;
    console.log(`${color}${data.message}${colors.reset}`);
  });

  return reporter;
}

export function createSSEReporter(res: ServerResponse, jobId: string): ProgressReporter {
  const reporter = new ProgressReporter();

  const sendSSE = (event: string, data: any) => {
    if (!res.writableEnded) {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify({ ...data, jobId, timestamp: Date.now() })}\n\n`);
    }
  };

  reporter.on('start', (data: ProgressData) => {
    sendSSE('start', data);
  });

  reporter.on('progress', (data: ProgressData) => {
    sendSSE('progress', data);
  });

  reporter.on('success', (data: ProgressData) => {
    sendSSE('success', data);
  });

  reporter.on('error', (data: ProgressData) => {
    sendSSE('error', data);
  });

  reporter.on('warning', (data: ProgressData) => {
    sendSSE('warning', data);
  });

  reporter.on('complete', (data: ProgressData) => {
    sendSSE('complete', data);
  });

  reporter.on('log', (data: any) => {
    sendSSE('log', data);
  });

  return reporter;
}

// Default reporter that does nothing (for backward compatibility)
export function createNullReporter(): ProgressReporter {
  return new ProgressReporter();
}
