to test the speakers using aplay:

`aplay -D plughw:4,0 /usr/share/sounds/alsa/Front_Left.wav`

to test recording:

 `arecord -D plughw:3,0 -f S16_LE -r 44100 -c 2 -d 10 test_recording.wav`

