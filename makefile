#!/usr/bin/make -f

# Makefile for PulseAudio Echo Cancellation Setup

.PHONY: setup-audio test-audio clean-audio list-devices

# Main setup command - restarts PulseAudio and configures echo cancellation
setup-audio:
	@echo "🔊 Restarting PulseAudio..."
	pulseaudio -k || true
	sleep 1
	pulseaudio --start
	sleep 2
	@echo "📋 Listing available sources and sinks..."
	pactl list short sources
	@echo "---"
	pactl list short sinks
	@echo "🔧 Setting up echo cancellation..."
	pactl unload-module module-echo-cancel 2>/dev/null || true
	pactl load-module module-echo-cancel \
		aec_method=webrtc \
		source_master=alsa_input.usb-Generic_Blue_Microphones_2140BAH0ANL8-00.analog-stereo \
		sink_master=alsa_output.usb-Jieli_Technology_UACDemoV1.0_4150344B32373109-00.analog-stereo \
		use_master_format=1 \
		source_name=echocancel_source \
		sink_name=echocancel_sink \
		rate=16000 \
  		format=s16le
	@echo "🎯 Setting default devices..."
	pactl set-default-source echocancel_source
	pactl set-default-sink echocancel_sink
	@echo "✅ Audio setup complete!"

# Test audio recording and playback
test-audio:
	@echo "🎙️ Recording 3-second test audio..."
	arecord -D pulse -f S16_LE -c1 -r 48000 -d 3 ./test_recording.wav
	@echo "🔊 Playing back test audio..."
	aplay -D pulse ./test_recording.wav
	@echo "🧹 Cleaning up test file..."
	rm -f ./test_recording.wav

# Quick test without cleanup
quick-test:
	@echo "🎙️ Recording 2-second test..."
	arecord -D pulse -f S16_LE -c1 -r 48000 -d 2 ./quick_test.wav
	@echo "🔊 Playing back..."
	aplay -D pulse ./quick_test.wav

# List all audio devices
list-devices:
	@echo "📋 Available Sources (Microphones):"
	pactl list short sources
	@echo "\n📋 Available Sinks (Speakers):"
	pactl list short sinks
	@echo "\n🎛️ Current Default Devices:"
	@echo "Default Source: $$(pactl get-default-source)"
	@echo "Default Sink: $$(pactl get-default-sink)"

# Clean up - remove echo cancellation and restart PulseAudio
clean-audio:
	@echo "🧹 Cleaning up audio setup..."
	pactl unload-module module-echo-cancel 2>/dev/null || true
	pulseaudio -k || true
	sleep 1
	pulseaudio --start
	@echo "✅ Audio reset to defaults"

# Show help
help:
	@echo "Available commands:"
	@echo "  make setup-audio   - Full audio setup with echo cancellation"
	@echo "  make test-audio    - Record and play back a test audio file"
	@echo "  make quick-test    - Quick 2-second audio test"
	@echo "  make list-devices  - List all available audio devices"
	@echo "  make clean-audio   - Reset audio to defaults"
	@echo "  make help          - Show this help message"