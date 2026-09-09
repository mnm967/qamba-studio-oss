"""worker/audio_fx.py — the render half of the effect catalog.

Two things are being protected here. One: the unit conversions, which are
where a preview silently stops matching the file (acompressor's threshold and
makeup are linear, ours are dB). Two: that a malformed row cannot produce a
filter string ffmpeg rejects — the whole filtergraph fails as a unit, so one
bad effect would take down an episode's render after the GPU has already been
paid for.

`test_audio_fx_ffmpeg.py` runs the strings this builds through the real
binary; these are the shapes and the arithmetic.
"""
import audio_fx


def fx(fid, **params):
    return {"id": fid, "params": params}


def test_no_effects_is_an_empty_chain():
    assert audio_fx.filters([]) == []
    assert audio_fx.chain(None) == ""


def test_unknown_effects_are_dropped_not_raised():
    assert audio_fx.filters([fx("vocoder"), fx("eq", low=6)]) == ["bass=g=6.00:f=200.0:width_type=q:width=0.707"]
    assert audio_fx.filters(["eq", None, 7]) == []


def test_echo_writes_out_the_repeats_tuna_gets_from_a_feedback_loop():
    # `aecho` is feed-forward (measured), so `feedback` cannot be handed to it
    # as a decay and left to ring: it produced exactly ONE repeat while the
    # preview rang on. And in_gain/out_gain both scale the DRY tap, so the old
    # `aecho=0.9:mix:...` also ducked the dry signal by 11dB at mix 0.3.
    out = audio_fx.filters([fx("echo", time=200, feedback=0.5, mix=0.3)])[0]
    assert out.startswith("aecho=1:1:"), "the dry signal must come through at unity"
    delays, gains = out[len("aecho=1:1:"):].split(":")
    assert delays.split("|")[:3] == ["200.0", "400.0", "600.0"]
    # Tuna's feedback gain sits in the direct wet path as well as in the loop,
    # so repeat n is mix * feedback**n and the first one is already scaled.
    assert gains.split("|")[:3] == ["0.1500", "0.0750", "0.0375"]


def test_order_is_the_signal_path():
    out = audio_fx.filters([fx("echo", mix=0.4), fx("compressor")])
    assert out[0].startswith("aecho")
    assert out[1].startswith("acompressor")


def test_a_flat_eq_produces_no_filter_at_all():
    assert audio_fx.filters([fx("eq", low=0, mid=0, high=0)]) == []
    # ...and a single moved band produces exactly one
    assert audio_fx.filters([fx("eq", low=0, mid=-3, high=0)]) == \
        ["equalizer=f=1200.0:t=q:w=1.000:g=-3.00"]


def test_an_inaudible_effect_is_left_out_of_the_graph():
    assert audio_fx.filters([fx("echo", mix=0)]) == []
    assert audio_fx.filters([fx("tremolo", depth=0)]) == []
    assert audio_fx.filters([fx("chorus", depth=0)]) == []


def test_compressor_converts_db_to_the_linear_values_ffmpeg_wants():
    out = audio_fx.filters([fx("compressor", threshold=-20, ratio=3, attack=10,
                               release=300, makeup=6)])[0]
    assert "threshold=0.100000" in out          # -20 dB
    # makeup = the user's +6 dB PLUS DynamicsCompressorNode's implicit
    # (1/fullScaleGain)^0.6 — at -20/3:1 with Tuna's 5 dB knee that is
    # 0.6 * (1 - 1/3) * (20 - 2.5) = +7.0 dB, so +13.0 total = 4.467x.
    # Pinning explicit-only makeup here is what let every compressed lane
    # render 10-17 dB quieter than the preview for the effect's whole life.
    assert "makeup=4.467" in out
    assert "ratio=3.00" in out and "attack=10.00" in out and "release=300.00" in out


def test_webaudio_auto_makeup_matches_the_spec_curve():
    # Above the knee: 0.6 * (1 - 1/R) * (-T - W/2). The three lanes of the
    # cut that surfaced this (measured -42.7 LUFS delivered).
    assert round(audio_fx._webaudio_auto_makeup_db(-37, 4), 1) == 15.5
    assert round(audio_fx._webaudio_auto_makeup_db(-48, 2.5), 1) == 16.4
    assert round(audio_fx._webaudio_auto_makeup_db(-25, 5), 1) == 10.8
    # Inside the knee (0 dBFS lands between T and T+W): quadratic branch.
    assert abs(audio_fx._webaudio_auto_makeup_db(-3, 4, knee_db=5)
               - 0.6 * (1 - 1 / 4) * 9 / 10.0) < 1e-9
    # Degenerate settings apply nothing.
    assert audio_fx._webaudio_auto_makeup_db(0, 4) == 0.0
    assert audio_fx._webaudio_auto_makeup_db(-20, 1) == 0.0


def test_compressor_makeup_is_clamped_to_acompressors_legal_range():
    # acompressor takes makeup in [1, 64] LINEAR. A huge threshold/ratio pair
    # plus explicit makeup can exceed 36 dB; passing it through raw fails the
    # whole filtergraph — i.e. the whole render — at its last step.
    out = audio_fx.filters([fx("compressor", threshold=-60, ratio=20, attack=5,
                               release=300, makeup=24)])[0]
    mk = float(out.split("makeup=")[1])
    assert 1.0 <= mk <= 64.0


def test_the_compressor_threshold_never_goes_below_what_ffmpeg_accepts():
    out = audio_fx.filters([fx("compressor", threshold=-60)])[0]
    thr = float(out.split("threshold=")[1].split(":")[0])
    assert thr >= 0.000976563


def test_filter_mode_picks_the_filter_and_defaults_to_high_pass():
    assert audio_fx.filters([fx("filter", mode="lowpass", freq=800)])[0].startswith("lowpass=f=800.0")
    assert audio_fx.filters([fx("filter", mode="banana")])[0].startswith("highpass=")


def test_out_of_range_values_are_clamped_rather_than_passed_through():
    out = audio_fx.filters([fx("filter", freq=10 ** 9, q=-4)])[0]
    assert "f=18000.0" in out and "width=0.100" in out
    hot = audio_fx.filters([fx("echo", feedback=99, mix=99, time=99999)])[0]
    assert hot.startswith("aecho=1:1:1000.0|2000.0|")   # time clamped to 1000ms
    assert len(hot.split(":")[3].split("|")) == audio_fx.ECHO_REPEATS


def test_junk_parameters_fall_back_to_the_default():
    out = audio_fx.filters([fx("tremolo", rate="fast", depth=0.5)])[0]
    assert out == "tremolo=f=5.000:d=0.500"


def test_the_chain_is_capped_at_four():
    long = [fx("eq", low=3)] * 9
    assert len(audio_fx.filters(long)) == audio_fx.MAX_FX


def test_chorus_uses_the_delay_tuna_can_also_reach():
    # 1.6ms sits inside Tuna's ~0.4-4ms range, so both engines describe the
    # same effect rather than two things that share a name.
    assert audio_fx.filters([fx("chorus", rate=2, depth=0.6)])[0] == "chorus=0.7:0.9:1.6:0.4:2.000:0.600"


def test_nothing_emits_a_character_that_would_break_the_filtergraph():
    every = [fx("eq", low=3, mid=-3, high=3), fx("filter"), fx("compressor"), fx("echo")]
    joined = audio_fx.chain(every)
    for ch in "[];'\"":
        assert ch not in joined


def test_a_powered_off_effect_reaches_the_render_as_nothing():
    # The panel's power button is stored, not panel state, so this is the
    # renderer agreeing with the editor rather than a second opinion.
    off = dict(fx("eq", low=6), enabled=False)
    assert audio_fx.filters([off]) == []
    assert audio_fx.filters([dict(off, enabled=True)]) == ["bass=g=6.00:f=200.0:width_type=q:width=0.707"]


def test_an_effect_with_no_enabled_key_still_plays():
    # Every row written before the flag existed.
    assert audio_fx.filters([fx("eq", low=6)]) == ["bass=g=6.00:f=200.0:width_type=q:width=0.707"]


# ------------------------------------------ overdrive, reverb, phaser, pan ---


def test_overdrive_is_a_gain_a_shaper_and_a_gain():
    out = audio_fx.filters([fx("overdrive", drive=12, output=-6)])
    assert out == ["volume=12.00dB",
                   "asoftclip=type=tanh:param=2.00",
                   "volume=-6.00dB"]


def test_the_shaper_type_is_the_one_the_browser_was_matched_against():
    # `asoftclip=type=tanh:param=2` is exactly tanh(2x) (measured against the
    # binary to 3.5e-8), and Tuna's curveAmount 0.46 was fitted to THAT. Change
    # the type or the param here and the preview silently stops matching.
    assert audio_fx.OD_CURVE == 2.0
    assert "type=tanh" in audio_fx.filters([fx("overdrive")])[1]


def test_reverb_tap_numbers_are_pinned_because_the_browser_produces_them_too():
    # src/lib/audioFx.test.ts asserts these same literals. The two are one
    # filter — `aecho` is feed-forward and the preview convolves with an
    # impulse response built from exactly these taps — so a drift in either
    # implementation is a preview that lies about the render.
    taps = audio_fx.reverb_taps(0.4, 1.6, 0.3)
    assert len(taps) == 107
    assert taps[0] == (73.3, 0.2186)
    assert taps[-1] == (1500.4, 0.0005)
    big = audio_fx.reverb_taps(1.0, 6.0, 1.0)
    assert len(big) == audio_fx.REVERB_TAPS
    assert big[0] == (202.2, 0.7923)


def test_reverb_taps_sit_on_the_minus_60db_envelope():
    for ms, gain in audio_fx.reverb_taps(0.4, 1.6, 1.0):
        assert abs(gain - 10.0 ** ((-3.0 * ms) / 1600.0)) <= 5e-5


def test_reverb_keeps_the_dry_signal_at_unity():
    # in_gain and out_gain BOTH scale the dry tap (measured), so anything other
    # than 1:1 here quietly attenuates the signal the reverb is added to. The
    # wet level lives in the tap gains instead.
    out = audio_fx.filters([fx("reverb", size=0.4, decay=1.6, mix=0.3)])[0]
    assert out.startswith("aecho=1:1:")
    delays, gains = out[len("aecho=1:1:"):].split(":")
    assert len(delays.split("|")) == len(gains.split("|")) == 107


def test_a_dry_reverb_is_no_filter_at_all():
    assert audio_fx.filters([fx("reverb", mix=0)]) == []


def test_pan_writes_the_web_audio_stereo_law():
    centre = audio_fx.pan_matrix(0.0)
    assert abs(centre[0][0] - 1) < 1e-12 and centre[0][1] < 1e-12
    left = audio_fx.pan_matrix(-1.0)
    assert left[0] == (1.0, 1.0), "hard left folds the right channel in"
    assert left[1][0] < 1e-12
    half = audio_fx.pan_matrix(-0.5)
    assert abs(half[0][1] - 0.7071067811865476) < 1e-12


def test_pan_normalises_to_stereo_first_and_that_is_load_bearing():
    # ffmpeg reads a channel the input does not have as ZERO, so without this a
    # MONO clip comes out hard left at every setting — silently.
    out = audio_fx.filters([fx("pan", pan=-0.5)])
    assert out[0] == "aformat=channel_layouts=stereo"
    assert out[1].startswith("pan=stereo|c0=")


def test_a_centred_pan_is_not_a_filter():
    assert audio_fx.filters([fx("pan", pan=0)]) == []
    assert audio_fx.filters([fx("pan", pan=0.005)]) == []


def test_phaser_maps_depth_onto_the_sweep_width_aphaser_expresses_as_delay():
    out = audio_fx.filters([fx("phaser", rate=0.5, depth=0.6, feedback=0.5)])[0]
    assert "delay=3.200" in out          # 0.5 + 4.5*0.6
    assert "decay=0.500" in out          # feedback, 1:1
    assert "speed=0.500" in out


def test_phaser_rate_is_clamped_to_what_aphaser_accepts():
    # Tuna would take 8Hz; aphaser's speed stops at 2.
    out = audio_fx.filters([fx("phaser", rate=99, depth=0.6)])[0]
    assert "speed=2.000" in out


def test_the_new_effects_survive_a_hand_mangled_row():
    junk = [fx("overdrive", drive="loud", output=None),
            fx("reverb", size=-9, decay="long", mix=99),
            fx("phaser", rate=float("nan"), depth=2, feedback="x"),
            fx("pan", pan="hard left")]
    for one in junk:
        for f in audio_fx.filters([one]):
            assert "nan" not in f.lower() and "none" not in f.lower(), f


# --------------------------------------------------------- the parametric EQ

BAND_CASES = [
    ({"type": "highpass", "freq": 80, "q": 0.7}, "highpass=f=80.0:width_type=q:width=0.700"),
    ({"type": "lowshelf", "freq": 200, "gain": 4}, "bass=g=4.00:f=200.0:width_type=q:width=0.707"),
    ({"type": "peaking", "freq": 2500, "gain": -4.5, "q": 3.2},
     "equalizer=f=2500.0:t=q:w=3.200:g=-4.50"),
    ({"type": "highshelf", "freq": 6000, "gain": 3}, "treble=g=3.00:f=6000.0:width_type=q:width=0.707"),
    ({"type": "lowpass", "freq": 12000, "q": 0.9}, "lowpass=f=12000.0:width_type=q:width=0.900"),
    ({"type": "notch", "freq": 50, "q": 10}, "bandreject=f=50.0:width_type=q:width=10.000"),
]


def test_every_band_type_maps_to_a_real_ffmpeg_filter():
    # The twin of the Web Audio check in src/lib/audioFx.test.ts: there the
    # types must be BiquadFilterNode names, here they must be ffmpeg filters.
    for band, want in BAND_CASES:
        assert audio_fx.filters([fx("eq", bands=[band])]) == [want], band["type"]


def test_a_legacy_eq_row_renders_as_the_three_bands_it_always_was():
    # It must keep SOUNDING the same, so: same shapes, same frequencies.
    out = audio_fx.filters([fx("eq", low=4, mid=-3, high=2)])
    assert out == ["bass=g=4.00:f=200.0:width_type=q:width=0.707",
                   "equalizer=f=1200.0:t=q:w=1.000:g=-3.00",
                   "treble=g=2.00:f=5000.0:width_type=q:width=0.707"]


def test_shelf_width_is_pinned_to_the_only_one_web_audio_has():
    # Web Audio's shelving filters IGNORE Q (the spec fixes S = 1) and RBJ's
    # shelf alpha at S = 1 is the Q form at 1/sqrt(2). Leaving ffmpeg's own
    # default of 0.5 in place — which this file did while the EQ had three
    # fixed bands — is itself a mismatch with the preview.
    out = audio_fx.filters([fx("eq", bands=[{"type": "lowshelf", "freq": 200, "gain": 5, "q": 9}])])[0]
    assert "width=0.707" in out, out


def test_a_band_doing_nothing_is_left_out_of_the_graph():
    assert audio_fx.filters([fx("eq", bands=[{"type": "peaking", "freq": 900, "gain": 0, "q": 4}])]) == []
    off = {"type": "peaking", "freq": 900, "gain": 6, "q": 4, "on": False}
    assert audio_fx.filters([fx("eq", bands=[off])]) == []
    # ...but a cut has no gain to be flat at, so it always renders
    assert len(audio_fx.filters([fx("eq", bands=[{"type": "highpass", "freq": 90}])])) == 1


def test_band_order_is_the_signal_path():
    out = audio_fx.filters([fx("eq", bands=[
        {"type": "highpass", "freq": 80},
        {"type": "peaking", "freq": 1000, "gain": 3},
    ])])
    assert out[0].startswith("highpass") and out[1].startswith("equalizer")


def test_the_band_list_is_capped():
    many = [{"type": "peaking", "freq": 100 + i * 100, "gain": 3} for i in range(20)]
    assert len(audio_fx.filters([fx("eq", bands=many)])) == audio_fx.MAX_EQ_BANDS


def test_a_hand_mangled_band_cannot_produce_a_graph_that_fails():
    junk = [{"type": "banana", "freq": 10 ** 9, "gain": "loud", "q": -5},
            {"type": "peaking", "freq": None, "gain": float("nan"), "q": 999},
            "not a band", None, 7]
    out = audio_fx.filters([fx("eq", bands=junk)])
    joined = ",".join(out)
    for bad in ("nan", "none", "banana"):
        assert bad not in joined.lower(), joined
    for ch in "[];'\"":
        assert ch not in joined
