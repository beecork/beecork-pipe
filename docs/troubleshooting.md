# Troubleshooting

## Common Issues

### "Claude Code not found"

Install Claude Code:
```bash
npm install -g @anthropic-ai/claude-code
```

Verify it works:
```bash
claude --version
```

### "Invalid Telegram token"

1. Check the token with BotFather: send `/mybots` to @BotFather
2. Make sure you copied the full token (format: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)
3. Revoke and create a new token if needed

### Daemon won't start

Run diagnostics:
```bash
beecork-pipe doctor
```

Check logs:
```bash
beecork-pipe logs
```

Check for stale PID file:
```bash
cat ~/.beecork-pipe/beecork.pid
# If the PID doesn't match a running process:
rm ~/.beecork-pipe/beecork.pid
beecork-pipe start
```

### Bot not responding

1. Check daemon is running: `beecork-pipe status`
2. Check Telegram token is valid: `beecork-pipe doctor`
3. Check your user ID is in the allowlist: look at `~/.beecork-pipe/config.json`
4. Check logs: `beecork-pipe logs`

### High costs

Check spending:
```bash
beecork-pipe status  # Shows cost summary
```

Set a budget limit in `~/.beecork-pipe/config.json`:
```json
{
  "claudeCode": {
    "maxBudgetUsd": 10.00
  }
}
```
