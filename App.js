import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, Share, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import {
  costFor, currentMpg, currentPrice, gbp, haversine, litresFor, monthSummary,
  officialMpg, pencePerMile, realMpg, sortEntries, todayKey,
} from './src/fuel';
import { loadData, newId, saveData } from './src/store';
import { currentPosition, useTripTracker } from './src/useTripTracker';

const C = {
  bg: '#0E1A17', surface: '#16261F', sunk: '#0A1411', line: '#26392F',
  ink: '#F3EFE6', muted: '#A9BBB5', amber: '#F2A93B', onAmber: '#1A1200',
  good: '#5BD497', plate: '#F5CF2E', warn: '#FFB4A2',
};
const MONO = Platform.select({ web: '"JetBrains Mono", ui-monospace, Menlo, monospace', ios: 'Menlo', default: 'monospace' });
const SANS = Platform.select({ web: 'Manrope, system-ui, -apple-system, sans-serif', default: undefined });

const num = (v) => {
  const n = parseFloat(String(v).replace(',', '.'));
  return isFinite(n) ? n : null;
};
const fmtTime = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
};
const niceDate = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

// ---------- small UI pieces ----------
function Btn({ title, onPress, kind = 'primary', disabled, style }) {
  const s = kind === 'primary' ? st.btn : kind === 'light' ? st.btnLight : st.btnQuiet;
  const t = kind === 'primary' ? st.btnText : kind === 'light' ? st.btnTextDark : st.btnTextQuiet;
  return (
    <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled}
      style={({ pressed }) => [s, disabled && { opacity: 0.45 }, pressed && { opacity: 0.8 }, style]}>
      <Text style={t}>{title}</Text>
    </Pressable>
  );
}
function Field({ label, value, onChangeText, placeholder, keyboard = 'default', upper, style }) {
  return (
    <View style={[st.field, style]}>
      <Text style={st.fieldLabel}>{label}</Text>
      <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor="#6F827B"
        keyboardType={keyboard} autoCapitalize={upper ? 'characters' : 'sentences'} autoCorrect={false}
        accessibilityLabel={label} style={st.input} />
    </View>
  );
}
const Label = ({ children, style }) => <Text style={[st.label, style]}>{children}</Text>;
const Mono = ({ style, children }) => <Text style={[{ fontFamily: MONO, color: C.ink, fontVariant: ['tabular-nums'] }, style]}>{children}</Text>;
function Stat({ label, value, sub }) {
  return (
    <View style={st.stat}>
      <Label>{label}</Label>
      <Mono style={{ fontSize: 22, fontWeight: '700' }}>{value}</Mono>
      {sub ? <Text style={st.small}>{sub}</Text> : null}
    </View>
  );
}

// ---------- app ----------
export default function App() {
  const [data, setData] = useState(null);
  const [screen, setScreen] = useState('home');
  const [toast, setToast] = useState(null);
  const [fillPrefill, setFillPrefill] = useState(null);
  const toastTimer = useRef(null);
  const tracker = useTripTracker(data ? data.spots : []);

  useEffect(() => {
    loadData().then((d) => {
      setData(d);
      if (!officialMpg(d.car) && !realMpg(d.entries)) setScreen('car');
    });
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      document.title = 'Miles & Pence';
      if (!document.getElementById('mp-fonts')) {
        const l = document.createElement('link');
        l.id = 'mp-fonts';
        l.rel = 'stylesheet';
        l.href = 'https://fonts.googleapis.com/css2?family=Manrope:wght@500;700;800&family=JetBrains+Mono:wght@500;700&display=swap';
        document.head.appendChild(l);
      }
    }
  }, []);

  const update = (fn) => {
    setData((prev) => {
      const next = fn(prev);
      saveData(next);
      return next;
    });
  };
  const say = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  };

  if (!data) return <View style={st.root} />;

  const mpg = currentMpg(data.car, data.entries);
  const price = currentPrice(data.car, data.entries);

  const addEntry = (e) => update((d) => ({ ...d, entries: [...d.entries, { id: newId(), createdAt: Date.now(), ...e }] }));

  const startTrip = async () => {
    const ok = await tracker.start();
    if (ok) setScreen('live');
  };
  const finishTrip = (thenScreen, spot) => {
    const r = tracker.stop();
    if (r.miles >= 0.05) {
      addEntry({ kind: 'trip', date: todayKey(), miles: Math.round(r.miles * 10) / 10, seconds: r.seconds, source: 'gps',
        name: spot ? 'To ' + spot.name : '', start: r.start, end: r.end });
      say('Trip saved: ' + r.miles.toFixed(1) + ' mi');
    } else say('Trip too short to save');
    if (thenScreen === 'fill') {
      setFillPrefill({ station: spot ? spot.name : '', spotId: spot ? spot.id : null });
      setScreen('fill');
    } else setScreen(thenScreen);
  };

  return (
    <View style={st.root}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={st.scroll} keyboardShouldPersistTaps="handled">
        <View style={st.col}>
          {screen === 'car' && <CarScreen data={data} update={update} onDone={() => { say('Car saved'); setScreen('home'); }} />}
          {screen === 'home' && (
            <HomeScreen data={data} mpg={mpg} price={price} tracker={tracker} onStart={startTrip}
              go={setScreen} onFill={() => { setFillPrefill(null); setScreen('fill'); }} />
          )}
          {screen === 'live' && (
            <LiveScreen tracker={tracker} mpg={mpg} price={price}
              onEnd={() => finishTrip('history')}
              onFuel={() => finishTrip('fill', tracker.atSpot)} />
          )}
          {screen === 'fill' && (
            <FillScreen data={data} price={price} prefill={fillPrefill} update={update} addEntry={addEntry} say={say}
              onDone={() => setScreen('history')} onCancel={() => setScreen('home')} />
          )}
          {screen === 'manual' && (
            <ManualTrip mpg={mpg} price={price} onSave={(t) => { addEntry(t); say('Trip saved'); setScreen('history'); }}
              onCancel={() => setScreen('home')} />
          )}
          {screen === 'history' && <HistoryScreen data={data} mpg={mpg} price={price} update={update} say={say} />}
        </View>
      </ScrollView>
      {screen !== 'live' && screen !== 'car' && (
        <View style={st.nav}>
          {[['home', 'Home'], ['history', 'History'], ['car', 'Car']].map(([k, t]) => (
            <Pressable key={k} accessibilityRole="button" onPress={() => setScreen(k)} style={st.navBtn}>
              <Text style={[st.navText, screen === k && { color: C.amber }]}>{t}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {toast ? <View style={st.toast} accessibilityLiveRegion="polite"><Text style={st.toastText}>{toast}</Text></View> : null}
    </View>
  );
}

// ---------- screens ----------
function Brand({ reg }) {
  return (
    <View style={st.top}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={st.badge}><Text style={{ fontWeight: '800', color: C.onAmber }}>£</Text></View>
        <Text style={st.brand}>Miles & Pence</Text>
      </View>
      {reg ? <Text style={st.plate}>{reg}</Text> : null}
    </View>
  );
}

function CarScreen({ data, update, onDone }) {
  const c = data.car || {};
  const [reg, setReg] = useState(c.reg || '');
  const [fuel, setFuel] = useState(c.fuel || 'petrol');
  const [co2, setCo2] = useState(c.co2 != null ? String(c.co2) : '');
  const [mpgIn, setMpgIn] = useState(c.mpg != null ? String(c.mpg) : '');
  const [priceIn, setPriceIn] = useState(c.price != null ? String(c.price) : '');
  const draft = { fuel, co2: num(co2), mpg: num(mpgIn), price: num(priceIn) };
  const off = officialMpg(draft);
  const ppm = pencePerMile(off, draft.price);
  const save = () => {
    update((d) => ({ ...d, car: { reg: reg.trim().toUpperCase(), ...draft } }));
    onDone();
  };
  return (
    <View style={st.gap}>
      <Brand />
      <Text style={st.h1}>{data.car ? 'Your car' : 'What do you drive?'}</Text>
      <Text style={st.body}>Your CO₂ figure is on your V5C logbook or any free reg-check site. We turn it into an mpg until your fill-ups give us the real one.</Text>
      <Field label="Registration" value={reg} onChangeText={setReg} placeholder="AB12 CDE" upper />
      <View>
        <Text style={st.fieldLabel}>Fuel</Text>
        <View style={st.seg}>
          {['petrol', 'diesel'].map((f) => (
            <Pressable key={f} accessibilityRole="button" accessibilityState={{ selected: fuel === f }} onPress={() => setFuel(f)}
              style={[st.segBtn, fuel === f && st.segOn]}>
              <Text style={[st.segText, fuel === f && { color: C.ink }]}>{f === 'petrol' ? 'Petrol' : 'Diesel'}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <View style={st.row}>
        <Field style={st.flex} label="CO₂ (g/km)" value={co2} onChangeText={setCo2} placeholder="e.g. 117" keyboard="decimal-pad" />
        <Field style={st.flex} label="Or your own mpg" value={mpgIn} onChangeText={setMpgIn} placeholder="Overrides CO₂" keyboard="decimal-pad" />
      </View>
      <Field label="Usual price (p per litre)" value={priceIn} onChangeText={setPriceIn} placeholder="e.g. 139.9" keyboard="decimal-pad" />
      <View style={st.card}>
        {off ? (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
              <Mono style={{ fontSize: 44, fontWeight: '700', color: C.amber }}>{off.toFixed(1)}</Mono>
              <Text style={[st.body, { color: C.ink, fontWeight: '700' }]}>mpg</Text>
            </View>
            <Text style={st.small}>{ppm ? 'About ' + ppm.toFixed(1) + 'p a mile at ' + draft.price + 'p/L' : 'Add a price to see cost per mile'}</Text>
          </>
        ) : <Text style={st.small}>Enter a CO₂ figure or an mpg to see your cost per mile.</Text>}
      </View>
      <Btn title="Save car" onPress={save} disabled={!off} />
    </View>
  );
}

function HomeScreen({ data, mpg, price, tracker, onStart, go, onFill }) {
  const s = monthSummary(data.car, data.entries, todayKey().slice(0, 7));
  const real = realMpg(data.entries);
  const ppm = pencePerMile(mpg, price);
  const month = new Date().toLocaleString('en-GB', { month: 'long' });
  const insecure = Platform.OS === 'web' && typeof window !== 'undefined' && !window.isSecureContext;
  return (
    <View style={st.gap}>
      <Brand reg={data.car && data.car.reg} />
      <View>
        <Label>{month} so far</Label>
        <Mono style={{ fontSize: 54, fontWeight: '700', letterSpacing: -2 }}>{gbp(s.est)}</Mono>
        <Text style={st.body}>{s.miles ? Math.round(s.miles * 10) / 10 + ' miles logged' : 'No trips yet this month'}</Text>
      </View>
      <Btn title={tracker.status === 'starting' ? 'Finding you…' : 'Start a trip'} onPress={onStart} disabled={tracker.status === 'starting'} style={{ height: 64 }} />
      {tracker.status === 'denied' ? (
        <Text style={st.warn}>Location is switched off for this site. On iPhone: Settings › Privacy & Security › Location Services › Safari Websites › While Using, then try again.</Text>
      ) : null}
      {tracker.error ? <Text style={st.warn}>GPS problem: {tracker.error}</Text> : null}
      {insecure ? <Text style={st.warn}>GPS only works when this page is opened from its https:// address.</Text> : null}
      <Text style={[st.small, { textAlign: 'center' }]}>Keep this page open with the phone on a mount. The screen stays on while a trip runs.</Text>
      <View style={st.stats}>
        <Stat label="Per mile" value={ppm ? ppm.toFixed(1) + 'p' : '–'} sub={price ? 'at ' + price + 'p/L' : 'add a price'} />
        <Stat label={real ? 'Your real mpg' : 'Official mpg'} value={mpg ? mpg.toFixed(1) : '–'} sub={real ? 'from your fill-ups' : 'until 2 full fill-ups'} />
      </View>
      <View style={st.row}>
        <Btn kind="quiet" title="Log a fill-up" onPress={onFill} style={st.flex} />
        <Btn kind="quiet" title="Add trip by hand" onPress={() => go('manual')} style={st.flex} />
      </View>
    </View>
  );
}

function LiveScreen({ tracker, mpg, price, onEnd, onFuel }) {
  const cost = costFor(tracker.miles, mpg, price);
  const gpsOk = tracker.accuracy != null && tracker.accuracy <= 35;
  return (
    <View style={st.gap}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: gpsOk ? C.good : C.amber }} />
        <Label>{gpsOk ? 'Trip in progress' : 'Waiting for a good GPS signal'}</Label>
      </View>
      <View style={{ alignItems: 'center', paddingVertical: 28, gap: 4 }}>
        <Text style={st.body}>This trip has cost</Text>
        <Mono style={{ fontSize: 76, fontWeight: '700', color: C.amber, letterSpacing: -3 }}>{cost != null ? gbp(cost) : '–'}</Mono>
        <Text style={st.small}>{fmtTime(tracker.elapsed)} driving</Text>
      </View>
      {tracker.atSpot ? (
        <View style={[st.card, { borderColor: C.amber }]}>
          <Text style={[st.h2, { fontSize: 18 }]}>Stopped at {tracker.atSpot.name}?</Text>
          <Text style={st.small}>End the trip here and log what you put in.</Text>
          <View style={st.row}>
            <Btn title="Log fill-up" onPress={onFuel} style={st.flex} />
            <Btn kind="quiet" title="Not now" onPress={tracker.dismissSpot} style={st.flex} />
          </View>
        </View>
      ) : null}
      <View style={st.stats3}>
        <Stat label="Miles" value={tracker.miles.toFixed(1)} />
        <Stat label="Litres" value={litresFor(tracker.miles, mpg).toFixed(2)} />
        <Stat label="mph" value={String(Math.round(tracker.speedMph))} />
      </View>
      <Text style={[st.small, { textAlign: 'center' }]}>GPS accuracy: {tracker.accuracy != null ? '±' + tracker.accuracy + ' m' : 'waiting…'}</Text>
      {tracker.error ? <Text style={st.warn}>GPS problem: {tracker.error}</Text> : null}
      <Btn kind="light" title="I'm at a fuel station" onPress={onFuel} />
      <Btn kind="quiet" title="End trip" onPress={onEnd} />
    </View>
  );
}

function FillScreen({ data, price, prefill, update, addEntry, say, onDone, onCancel }) {
  const [date] = useState(todayKey());
  const [spend, setSpend] = useState('');
  const [p, setP] = useState(price ? String(price) : '');
  const [odo, setOdo] = useState('');
  const [station, setStation] = useState(prefill ? prefill.station : '');
  const [full, setFull] = useState(true);
  const [saveSpot, setSaveSpot] = useState(!(prefill && prefill.spotId));
  const [busy, setBusy] = useState(false);
  const sp = num(spend), pr = num(p);
  const litres = sp && pr ? sp / (pr / 100) : null;

  const save = async () => {
    if (!sp || !pr) return;
    setBusy(true);
    let newSpot = null;
    if (saveSpot) {
      try {
        const pos = await currentPosition();
        const tooClose = data.spots.some((s) => haversine(s, pos) < 60);
        if (!tooClose) newSpot = { id: Date.now().toString(36), name: station.trim() || 'Fuel station', latitude: pos.latitude, longitude: pos.longitude };
      } catch (e) {
        say("Couldn't get your location, so the station wasn't saved");
      }
    }
    if (newSpot) update((d) => ({ ...d, spots: [...d.spots, newSpot] }));
    addEntry({ kind: 'fill', date, spend: Math.round(sp * 100) / 100, price: pr, litres: Math.round(litres * 100) / 100,
      odo: num(odo), station: station.trim(), full });
    setBusy(false);
    say(newSpot ? 'Fill-up and station saved' : 'Fill-up saved');
    onDone();
  };

  return (
    <View style={st.gap}>
      <Brand reg={data.car && data.car.reg} />
      <Text style={st.h1}>{prefill && prefill.station ? 'Filling up at ' + prefill.station + '?' : 'Log a fill-up'}</Text>
      <View style={st.row}>
        <Field style={st.flex} label="Spent (£)" value={spend} onChangeText={setSpend} placeholder="50.00" keyboard="decimal-pad" />
        <Field style={st.flex} label="Price (p/L)" value={p} onChangeText={setP} placeholder="139.9" keyboard="decimal-pad" />
      </View>
      <Text style={st.body}>{litres ? 'That’s ' + litres.toFixed(1) + ' litres.' : 'Litres appear here as you type.'}</Text>
      <Field label="Odometer (miles, optional)" value={odo} onChangeText={setOdo} placeholder="e.g. 48213" keyboard="number-pad" />
      <Field label="Station" value={station} onChangeText={setStation} placeholder="e.g. Tesco, Leigh" />
      <View style={st.switchRow}>
        <Text style={st.switchText}>Filled to full</Text>
        <Switch value={full} onValueChange={setFull} trackColor={{ true: C.amber, false: C.line }} accessibilityLabel="Filled to full" />
      </View>
      {!(prefill && prefill.spotId) ? (
        <View style={st.switchRow}>
          <View style={{ flex: 1 }}>
            <Text style={st.switchText}>Remember this station</Text>
            <Text style={st.small}>Saves where you are now, so next time you stop here we'll ask about fuel.</Text>
          </View>
          <Switch value={saveSpot} onValueChange={setSaveSpot} trackColor={{ true: C.amber, false: C.line }} accessibilityLabel="Remember this station" />
        </View>
      ) : null}
      <Text style={st.small}>Two full fill-ups in a row give us your real mpg. The odometer reading makes it exact.</Text>
      <Btn title={busy ? 'Saving…' : 'Save fill-up'} onPress={save} disabled={!sp || !pr || busy} />
      <Btn kind="quiet" title="Cancel" onPress={onCancel} />
    </View>
  );
}

function ManualTrip({ mpg, price, onSave, onCancel }) {
  const [miles, setMiles] = useState('');
  const [name, setName] = useState('');
  const m = num(miles);
  const c = costFor(m, mpg, price);
  return (
    <View style={st.gap}>
      <Brand />
      <Text style={st.h1}>Add a trip by hand</Text>
      <Text style={st.body}>For journeys where GPS wasn't running. Take miles from your trip computer or a map.</Text>
      <View style={st.row}>
        <Field style={st.flex} label="Miles" value={miles} onChangeText={setMiles} placeholder="14.3" keyboard="decimal-pad" />
        <Field style={[st.flex, { flexGrow: 2 }]} label="Where to" value={name} onChangeText={setName} placeholder="Home to work" />
      </View>
      <Text style={st.body}>{m && c != null ? 'About ' + gbp(c) + ' of fuel.' : 'Cost appears here as you type.'}</Text>
      <Btn title="Save trip" disabled={!m} onPress={() => onSave({ kind: 'trip', date: todayKey(), miles: Math.round(m * 10) / 10, name: name.trim(), source: 'manual' })} />
      <Btn kind="quiet" title="Cancel" onPress={onCancel} />
    </View>
  );
}

function HistoryScreen({ data, mpg, price, update, say }) {
  const [armed, setArmed] = useState(null);
  const s = monthSummary(data.car, data.entries, todayKey().slice(0, 7));
  const list = useMemo(() => sortEntries(data.entries).reverse(), [data.entries]);
  const remove = (id) => {
    if (armed !== id) {
      setArmed(id);
      setTimeout(() => setArmed((a) => (a === id ? null : a)), 3000);
      return;
    }
    update((d) => ({ ...d, entries: d.entries.filter((e) => e.id !== id) }));
    setArmed(null);
  };
  const exportData = async () => {
    const text = JSON.stringify({ exported: new Date().toISOString(), ...data }, null, 1);
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ title: 'Miles & Pence data', text });
      } else if (Platform.OS === 'web' && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        say('Copied. Paste it into Claude to analyse.');
      } else {
        await Share.share({ message: text });
      }
    } catch (e) {
      if (!(e && e.name === 'AbortError')) say("Couldn't share the data");
    }
  };
  return (
    <View style={st.gap}>
      <Brand reg={data.car && data.car.reg} />
      <Text style={st.h1}>History</Text>
      <View style={st.card}>
        <Label>Does it add up? ({new Date().toLocaleString('en-GB', { month: 'long' })})</Label>
        <View style={st.between}><Text style={st.body}>Trips, estimated</Text><Mono style={{ fontSize: 17 }}>{gbp(s.est)}</Mono></View>
        <View style={st.between}><Text style={st.body}>Fuel bought</Text><Mono style={{ fontSize: 17 }}>{gbp(s.bought)}</Mono></View>
        <Text style={st.small}>Over a few weeks these should end up close. A big gap means a missed trip or an mpg that's off.</Text>
      </View>
      {list.length === 0 ? (
        <View style={st.empty}><Text style={[st.body, { color: C.ink, fontWeight: '700' }]}>Nothing logged yet</Text><Text style={st.small}>Go back to Home and start a trip.</Text></View>
      ) : list.map((e) => {
        const isTrip = e.kind === 'trip';
        const cost = isTrip ? costFor(e.miles, mpg, price) : e.spend;
        const meta = isTrip
          ? niceDate(e.date) + ' · ' + e.miles + ' mi' + (e.seconds ? ' · ' + Math.round(e.seconds / 60) + ' min' : '') + (e.source === 'gps' ? ' · GPS' : ' · by hand')
          : niceDate(e.date) + ' · ' + (e.litres || 0).toFixed(1) + ' L at ' + e.price + 'p' + (e.full ? ' · full' : '') + (e.odo ? ' · ' + e.odo + ' mi' : '');
        return (
          <View key={e.id} style={st.item}>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text style={st.itemTitle}><Text style={st.kind}>{isTrip ? 'TRIP  ' : 'FILL-UP  '}</Text>{isTrip ? e.name || 'Trip' : e.station || 'Fill-up'}</Text>
              <Text style={st.small}>{meta}</Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 2 }}>
              <Mono style={{ fontSize: 17, fontWeight: '700', color: isTrip ? C.ink : C.amber }}>{cost != null ? gbp(cost) : '–'}</Mono>
              <Pressable accessibilityRole="button" onPress={() => remove(e.id)} hitSlop={10}>
                <Text style={[st.small, { textDecorationLine: 'underline', color: armed === e.id ? C.warn : C.muted }]}>{armed === e.id ? 'Tap again to delete' : 'Delete'}</Text>
              </Pressable>
            </View>
          </View>
        );
      })}
      {data.spots.length ? (
        <View style={st.card}>
          <Label>Saved fuel stations</Label>
          {data.spots.map((s) => (
            <View key={s.id} style={st.between}>
              <Text style={st.body}>{s.name}</Text>
              <Pressable accessibilityRole="button" onPress={() => update((d) => ({ ...d, spots: d.spots.filter((x) => x.id !== s.id) }))} hitSlop={10}>
                <Text style={[st.small, { textDecorationLine: 'underline' }]}>Remove</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      <Btn kind="quiet" title="Export my data" onPress={exportData} />
      <Text style={st.small}>Sends everything as text so you can paste it into Claude for a check-up.</Text>
    </View>
  );
}

// ---------- styles ----------
const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  scroll: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 24, paddingBottom: 110 },
  col: { width: '100%', maxWidth: 520, alignSelf: 'center' },
  gap: { gap: 16 },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  badge: { width: 34, height: 34, borderRadius: 10, backgroundColor: C.amber, alignItems: 'center', justifyContent: 'center' },
  brand: { color: C.ink, fontSize: 18, fontWeight: '800', fontFamily: SANS },
  plate: { fontFamily: MONO, fontWeight: '700', fontSize: 13, backgroundColor: C.plate, color: '#111', paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6, overflow: 'hidden', letterSpacing: 1 },
  h1: { color: C.ink, fontSize: 30, fontWeight: '800', letterSpacing: -0.6, fontFamily: SANS },
  h2: { color: C.ink, fontWeight: '800', fontFamily: SANS },
  body: { color: C.muted, fontSize: 15, lineHeight: 22, fontFamily: SANS },
  small: { color: C.muted, fontSize: 13, lineHeight: 18, fontFamily: SANS },
  warn: { color: C.warn, fontSize: 14, lineHeight: 20, fontFamily: SANS },
  label: { color: C.muted, fontSize: 12, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', fontFamily: SANS },
  row: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  flex: { flexGrow: 1, flexBasis: 130, minWidth: 0 },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  field: { gap: 6 },
  fieldLabel: { color: C.muted, fontSize: 13, fontWeight: '600', fontFamily: SANS, marginBottom: 6 },
  input: { height: 48, borderRadius: 12, borderWidth: 1, borderColor: C.line, backgroundColor: C.sunk, color: C.ink, paddingHorizontal: 12, fontSize: 17, fontFamily: SANS },
  seg: { flexDirection: 'row', backgroundColor: C.sunk, borderRadius: 12, padding: 4, gap: 4 },
  segBtn: { flex: 1, height: 42, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: C.surface },
  segText: { color: C.muted, fontWeight: '700', fontFamily: SANS },
  card: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, borderRadius: 18, padding: 16, gap: 10 },
  stats: { flexDirection: 'row', gap: 10 },
  stats3: { flexDirection: 'row', gap: 8 },
  stat: { flex: 1, backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, borderRadius: 14, padding: 12, gap: 2, minWidth: 0 },
  btn: { height: 54, borderRadius: 16, backgroundColor: C.amber, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  btnLight: { height: 54, borderRadius: 16, backgroundColor: C.ink, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  btnQuiet: { height: 48, borderRadius: 14, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  btnText: { color: C.onAmber, fontSize: 17, fontWeight: '800', fontFamily: SANS },
  btnTextDark: { color: C.bg, fontSize: 17, fontWeight: '800', fontFamily: SANS },
  btnTextQuiet: { color: C.ink, fontSize: 15, fontWeight: '700', fontFamily: SANS },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 44 },
  switchText: { color: C.ink, fontSize: 15, fontWeight: '600', fontFamily: SANS },
  item: { flexDirection: 'row', gap: 12, backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, borderRadius: 14, padding: 14, alignItems: 'center' },
  itemTitle: { color: C.ink, fontSize: 15, fontWeight: '700', fontFamily: SANS },
  kind: { color: C.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  empty: { borderWidth: 1, borderStyle: 'dashed', borderColor: C.line, borderRadius: 14, padding: 18, gap: 4 },
  nav: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', borderTopWidth: 1, borderTopColor: C.line, backgroundColor: C.bg, paddingBottom: 24, paddingTop: 6 },
  navBtn: { flex: 1, height: 48, alignItems: 'center', justifyContent: 'center' },
  navText: { color: C.muted, fontWeight: '700', fontSize: 14, fontFamily: SANS },
  toast: { position: 'absolute', bottom: 96, alignSelf: 'center', backgroundColor: C.ink, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10 },
  toastText: { color: C.bg, fontWeight: '700', fontFamily: SANS },
});
