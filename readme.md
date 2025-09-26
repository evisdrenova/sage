# Sage

Open source voice agent that runs on a raspberry pi.

## The agentic loop

1. Main process starts
2. Start parec for wake word detection 
3. User says wake word
4. Picovoice picks it up. Kill parec, start conversation mode:
    a. Start new parec for user input
    b. Connect to OpenAI Realtime API
LOOP:
5. User speaks (mic is still active for interruptions)
6. Agent responds
7. OpenAI VAD detects silence and fires conversation.item.completed or similar event
    a. On completion: set a 5-second timeout
    b. If user speaks within 5 seconds → cancel timeout, continue conversation
    c. If 5 seconds pass with no speech → exit conversation
8. Kill conversation parec, restart wake word parec


Make file has set up commands:

```bash
bash# Main setup command (replaces your entire command sequence)
make setup-audio

# Test your audio setup
make test-audio

# Quick 2-second test
make quick-test

# List all devices and current defaults
make list-devices

# Reset everything back to defaults
make clean-audio

# Show help
make help
```

Check your default source, should be `echocancel_source`
`pactl get-default-source`