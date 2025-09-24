to test the speakers using aplay:

`aplay -D plughw:4,0 /usr/share/sounds/alsa/Front_Left.wav`

to test recording using alsa:

 `arecord -D plughw:3,0 -f S16_LE -r 44100 -c 2 -d 10 test_recording.wav`

the commands to set things up if they're not working:

```bash
orangepi@orangepizero3:~/sage$ pulseaudio -k
orangepi@orangepizero3:~/sage$ pulseaudio --start
orangepi@orangepizero3:~/sage$ pactl list short sources
0       alsa_output.platform-5096000.codec.stereo-fallback.monitor      module-alsa-card.c      s16le 2ch 44100Hz       IDLE
1       alsa_output.usb-Generic_Blue_Microphones_2140BAH0ANL8-00.analog-stereo.monitor  module-alsa-card.c      s16le 2ch 44100Hz   IDLE
2       alsa_input.usb-Generic_Blue_Microphones_2140BAH0ANL8-00.analog-stereo   module-alsa-card.c      s16le 2ch 44100Hz  IDLE
3       alsa_output.usb-Jieli_Technology_UACDemoV1.0_4150344B32373109-00.analog-stereo.monitor  module-alsa-card.c      s16le 2ch 48000Hz   IDLE
4       alsa_output.platform-soc_ahub1_mach.stereo-fallback.monitor     module-alsa-card.c      s16le 2ch 44100Hz       IDLE
orangepi@orangepizero3:~/sage$ pactl list short sinks
0       alsa_output.platform-5096000.codec.stereo-fallback      module-alsa-card.c      s16le 2ch 44100Hz       SUSPENDED
1       alsa_output.usb-Generic_Blue_Microphones_2140BAH0ANL8-00.analog-stereo  module-alsa-card.c      s16le 2ch 44100Hz       SUSPENDED
2       alsa_output.usb-Jieli_Technology_UACDemoV1.0_4150344B32373109-00.analog-stereo  module-alsa-card.c      s16le 2ch 48000Hz       SUSPENDED
3       alsa_output.platform-soc_ahub1_mach.stereo-fallback     module-alsa-card.c      s16le 2ch 44100Hz       SUSPENDED
orangepi@orangepizero3:~/sage$ pactl unload-module module-echo-cancel 2>/dev/null || true
orangepi@orangepizero3:~/sage$ pactl load-module module-echo-cancel \
  aec_method=webrtc \
  source_master=alsa_input.usb-Generic_Blue_Microphones_2140BAH0ANL8-00.analog-stereo \
  sink_master=alsa_output.usb-Jieli_Technology_UACDemoV1.0_4150344B32373109-00.analog-stereo \
  use_master_format=1 \
  source_name=echocancel_source \
  sink_name=echocancel_sink
21
orangepi@orangepizero3:~/sage$ pactl set-default-source echocancel_source
orangepi@orangepizero3:~/sage$ pactl set-default-sink   echocancel_sink
orangepi@orangepizero3:~/sage$ arecord -D pulse -f S16_LE -c1 -r 48000 -d 3 ./testp.wav
Recording WAVE './testp.wav' : Signed 16 bit Little Endian, Rate 48000 Hz, Mono
orangepi@orangepizero3:~/sage$ aplay   -D pulse ./test.wav

```
