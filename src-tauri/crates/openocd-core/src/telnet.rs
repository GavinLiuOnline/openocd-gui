//! Minimal telnet client tailored to OpenOCD's command server.
//!
//! OpenOCD exposes a telnet server (default port 4444). Protocol details:
//! - Banner on connect: e.g. "Open On-Chip Debugger" followed by a prompt.
//! - Prompt is "> " (appears at the start of a line).
//! - Each command is echoed back before its output.
//! - The server may send telnet negotiation (IAC) sequences; we strip them
//!   and reply with standard DO/WONT responses.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;

const PROMPT: &[u8] = b"> ";
/// Prompt patterns seen in the wild:
/// - openocd 0.12 emits "\r\n\r> " (CR LF CR then prompt)
/// - other versions / banners may emit "\n> "
const PROMPTS: [&[u8]; 2] = [b"\r\n\r> ", b"\n> "];

#[derive(Debug, thiserror::Error)]
pub enum TelnetError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("connection closed by openocd")]
    Closed,
    #[error("timeout waiting for openocd prompt (command still running?)")]
    Timeout,
}

pub struct TelnetClient {
    stream: TcpStream,
    buf: Vec<u8>,
}

impl TelnetClient {
    pub async fn connect(port: u16, connect_timeout: Duration) -> Result<Self, TelnetError> {
        let stream = timeout(connect_timeout, TcpStream::connect(("127.0.0.1", port)))
            .await
            .map_err(|_| TelnetError::Timeout)??;
        Ok(Self { stream, buf: Vec::new() })
    }

    /// Send a command line (a `\n` terminator is appended).
    pub async fn send(&mut self, line: &str) -> Result<(), TelnetError> {
        self.stream.write_all(line.trim().as_bytes()).await?;
        self.stream.write_all(b"\n").await?;
        self.stream.flush().await?;
        Ok(())
    }

    /// Read from the socket, stripping/answering telnet IAC negotiation.
    async fn fill(&mut self) -> Result<(), TelnetError> {
        let mut chunk = [0u8; 8192];
        let n = self.stream.read(&mut chunk).await?;
        if n == 0 {
            return Err(TelnetError::Closed);
        }
        let mut out = Vec::with_capacity(n);
        let mut i = 0;
        while i < n {
            let b = chunk[i];
            if b != IAC {
                out.push(b);
                i += 1;
                continue;
            }
            // IAC sequence
            if i + 1 >= n {
                break; // incomplete sequence at chunk edge; drop it
            }
            match chunk[i + 1] {
                IAC => {
                    out.push(IAC);
                    i += 2;
                }
                WILL | WONT | DO | DONT => {
                    if i + 2 >= n {
                        break;
                    }
                    let opt = chunk[i + 2];
                    // Standard replies: WILL x -> DO x, DO x -> WONT x
                    let reply: [u8; 3] = if chunk[i + 1] == WILL {
                        [IAC, DO, opt]
                    } else {
                        [IAC, WONT, opt]
                    };
                    let _ = self.stream.write_all(&reply).await;
                    i += 3;
                }
                SB => {
                    // skip subnegotiation until IAC SE
                    let mut j = i + 2;
                    let mut done = false;
                    while j + 1 < n {
                        if chunk[j] == IAC && chunk[j + 1] == SE {
                            i = j + 2;
                            done = true;
                            break;
                        }
                        j += 1;
                    }
                    if !done {
                        break;
                    }
                }
                _ => {
                    // 2-byte commands (NOP, GO_AHEAD, ...)
                    i += 2;
                }
            }
        }
        // Strip NUL bytes: openocd's telnet echo leaks a C-string terminator
        // after the echoed command line ("\r\n\0").
        out.retain(|&b| b != 0);
        self.buf.extend_from_slice(&out);
        Ok(())
    }

    /// Read until the prompt appears. Returns all text before the prompt
    /// (including the echoed command). `\r` characters are removed.
    pub async fn read_until_prompt(&mut self, t: Duration) -> Result<String, TelnetError> {
        let fut = async {
            loop {
                if let Some((end, plen)) = find_prompt(&self.buf) {
                    let text: Vec<u8> = self.buf.drain(..end).collect();
                    let skip = end + plen;
                    self.buf.drain(..skip.min(self.buf.len()));
                    let s = String::from_utf8_lossy(&text).replace('\r', "");
                    return Ok(s);
                }
                self.fill().await?;
            }
        };
        timeout(t, fut).await.map_err(|_| TelnetError::Timeout)?
    }

    /// Discard everything currently buffered (e.g. stray output).
    pub fn clear_buffer(&mut self) {
        self.buf.clear();
    }
}

fn find_sub(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.len() > hay.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

/// Find the prompt "> " at the start of a line in `buf`.
/// Returns `(text_end, prompt_len)`: the text before `text_end` excludes the
/// whole prompt pattern.
fn find_prompt(buf: &[u8]) -> Option<(usize, usize)> {
    let mut best: Option<(usize, usize)> = None;
    if buf.starts_with(PROMPT) {
        best = Some((0, PROMPT.len()));
    }
    for p in PROMPTS {
        if let Some(pos) = find_sub(buf, p) {
            if best.map_or(true, |(e, _)| pos < e) {
                best = Some((pos, p.len()));
            }
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_after_banner() {
        // openocd 0.12 emits "\r\n\r> " after the banner.
        let data = b"Open On-Chip Debugger\r\n\r> ";
        assert_eq!(find_prompt(data), Some((21, 5)));
    }

    #[test]
    fn prompt_lf_only() {
        // Some versions / framings produce a plain "\n> ".
        let data = b"version\nOpen On-Chip Debugger 0.12.0\n> ";
        assert_eq!(find_prompt(data), Some((36, 3)));
    }

    #[test]
    fn no_prompt_inside_output() {
        let data = b"some > inline\nstill no prompt\n";
        assert_eq!(find_prompt(data), None);
    }

    #[test]
    fn prompt_at_start() {
        let data = b"> ";
        assert_eq!(find_prompt(data), Some((0, 2)));
    }
}
