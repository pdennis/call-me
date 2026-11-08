/**
 * Single phone line shared by every Claude session on this machine (static URL mode).
 *
 * The fixed port behind CALLME_PUBLIC_URL can only be bound by one session. Whoever
 * holds it also listens on a Unix control socket; a session that wants to place a
 * call asks the holder to release the port, and the holder agrees unless it is on a
 * call. So the line goes to whichever session needs it, and a forgotten idle session
 * can no longer keep it forever.
 *
 * The control channel is a Unix socket, never an HTTP route: the port itself is
 * publicly funnelled, and anyone on the internet could otherwise ask it to let go.
 */

import { createConnection, createServer, Server } from 'net';
import { existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { CallManager } from './phone-call.js';

const CONTROL_TIMEOUT_MS = 3000;

export class PhoneLine {
  private control: Server | null = null;
  private socketPath: string;
  held = false;

  constructor(private callManager: CallManager, port: number) {
    const dir = process.env.XDG_RUNTIME_DIR || tmpdir();
    this.socketPath = join(dir, `callme-line-${port}.sock`);
  }

  /** Bind the port if it is free. Never takes the line from another session. */
  async tryAcquire(): Promise<boolean> {
    try {
      await this.callManager.startServer();
    } catch (error: any) {
      if (error?.code === 'EADDRINUSE') return false;
      throw error;
    }
    this.held = true;
    this.listenForRelease();
    return true;
  }

  /**
   * Take the line from whichever session holds it. Throws with a user-facing
   * reason when the holder is on a call, unresponsive, or predates takeover.
   */
  async takeOver(): Promise<void> {
    if (this.held) return;
    if (await this.tryAcquire()) return;

    const reply = await this.askHolderToRelease();
    if (reply === 'busy') {
      throw new Error('Another Claude Code session is on a call right now. Tell the user in text instead.');
    }
    if (reply !== 'released') {
      throw new Error(
        'Another Claude Code session is holding the phone line and did not hand it over ' +
        '(it may be running an older callme). Tell the user in text instead.'
      );
    }

    // The holder has closed its server; the port can take a moment to come free
    for (let attempt = 0; attempt < 10; attempt++) {
      if (await this.tryAcquire()) {
        console.error('[line] Took over the phone line from another session');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('The phone line was released but this session could not bind it. Tell the user in text instead.');
  }

  /** Close the control socket on shutdown, removing it only if it is ours. */
  close(): void {
    if (!this.control) return;
    this.control.close();
    this.control = null;
    try { unlinkSync(this.socketPath); } catch { }
  }

  private listenForRelease(): void {
    // A socket left behind by a holder that died without cleanup; we hold the port, so it is stale
    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch { }
    }
    this.control = createServer(conn => {
      conn.setEncoding('utf8');
      conn.once('data', async (data: string) => {
        if (data.trim() !== 'release') {
          conn.end('unknown\n');
          return;
        }
        if (!(await this.callManager.releaseServer())) {
          conn.end('busy\n');
          return;
        }
        this.held = false;
        // Stop answering before replying so the new holder can create its own socket
        this.close();
        console.error('[line] Released the phone line to another session');
        conn.end('released\n');
      });
    });
    this.control.on('error', err => console.error('[line] Control socket error:', err));
    this.control.listen(this.socketPath);
  }

  private askHolderToRelease(): Promise<string> {
    return new Promise(resolve => {
      let reply = '';
      const conn = createConnection(this.socketPath);
      const timer = setTimeout(() => { conn.destroy(); resolve('timeout'); }, CONTROL_TIMEOUT_MS);
      conn.setEncoding('utf8');
      conn.on('connect', () => conn.write('release\n'));
      conn.on('data', (data: string) => { reply += data; });
      conn.on('end', () => { clearTimeout(timer); resolve(reply.trim()); });
      conn.on('error', () => { clearTimeout(timer); resolve('unreachable'); });
    });
  }
}
