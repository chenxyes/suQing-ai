# ASR probe audio

`asr-probe.wav` contains only the synthetic phrase:

> Hello. This is a speech recognition test.

PCM WAV, mono, 16-bit, 16 kHz, 3.04725 seconds. No user recording or production data is included. Generated locally for this probe with macOS speech synthesis:

```sh
say -v Samantha -r 150 -o asr-probe.wav --file-format=WAVE --data-format=LEI16@16000 'Hello. This is a speech recognition test.'
```

The binary is bundled so Linux/container deployments do not require a speech synthesizer. `scripts/provider_review_check.mjs` parses its WAV chunks and verifies format, duration and nonzero samples through the actual probe request. The probe checks the response for the spoken words “speech recognition test”, ignoring case/punctuation. These local checks do not establish real-provider compatibility.
