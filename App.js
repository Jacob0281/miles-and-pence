import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, Share, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import {
  calibrate, costFor, currentMpg, currentPrice, gbp, LITRES_PER_GALLON, monthSummary, mpgAtSpeed,
  needsOdoThisMonth, odoCheck, officialMpg, pencePerMile, sortEntries, todayKey, tripFuel,
} from './src/fuel';
import { loadData, newId, saveData } from './src/store';
import { useTripTracker } from './src/useTripTracker';
import { livePrice } from './src/stations';
import { VEHICLE_LOOKUP_URL } from './src/config';

const ago = (iso) => {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!isFinite(mins) || mins < 0) return '';
  if (mins < 60) return mins + ' min ago';
  const h = Math.round(mins / 60);
  return h < 48 ? h + ' hr ago' : Math.round(h / 24) + ' days ago';
};
const fuelLabel = (car) => {
  const diesel = car && car.fuel === 'diesel';
  const premium = car && car.grade === 'premium';
  return diesel ? (premium ? 'Premium diesel' : 'Diesel') : premium ? 'Super unleaded' : 'Unleaded';
};

const C = {
  bg: '#0E1A17', surface: '#16261F', sunk: '#0A1411', line: '#26392F',
  ink: '#F3EFE6', muted: '#A9BBB5', amber: '#F2A93B', onAmber: '#1A1200',
  good: '#5BD497', plate: '#F5CF2E', warn: '#FFB4A2',
};
const MONO = Platform.select({ web: '"JetBrains Mono", ui-monospace, Menlo, monospace', ios: 'Menlo', default: 'monospace' });
const SANS = Platform.select({ web: 'Manrope, system-ui, -apple-system, sans-serif', default: undefined });
const SPEND_CHIPS = [10, 20, 30, 40, 50, 60];

const num = (v) => {
  const n = parseFloat(String(v).replace(',', '.').replace('£', ''));
  return isFinite(n) ? n : null;
};
const fmtTime = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
};
const niceDate = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const monthName = () => new Date().toLocaleString('en-GB', { month: 'long' });

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
  const [fillStation, setFillStation] = useState(null);
  const toastTimer = useRef(null);

  const car = data ? data.car : null;
  const entries = data ? data.entries : [];
  const cal = useMemo(() => calibrate(car, entries), [car, entries]);
  const baseMpg = officialMpg(car) || cal.realMpg;
  const tracker = useTripTracker({ baseMpg, fuel: (car && car.fuel) || 'petrol' });

  useEffect(() => {
    loadData().then((d) => {
      setData(d);
      if (!officialMpg(d.car)) setScreen('car');
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

  const update = (fn) => setData((prev) => {
    const next = fn(prev);
    saveData(next);
    return next;
  });
  const say = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  };

  if (!data) return <View style={st.root} />;

  const price = currentPrice(car, entries);
  const mpg = currentMpg(car, entries);
  const addEntry = (e) => update((d) => ({ ...d, entries: [...d.entries, { id: newId(), createdAt: Date.now(), ...e }] }));

  const startTrip = async () => {
    const ok = await tracker.start();
    if (ok) setScreen('live');
  };
  const finishTrip = (station) => {
    const r = tracker.stop();
    if (r.miles >= 0.05) {
      addEntry({ kind: 'trip', date: todayKey(), source: 'gps', name: station ? 'To ' + station.name : '',
        miles: Math.round(r.miles * 10) / 10, litres: r.litres, seconds: r.seconds, idleSeconds: r.idleSeconds,
        bands: r.bands, gapMiles: r.gapMiles, start: r.start, end: r.end });
      say('Trip saved: ' + r.miles.toFixed(1) + ' mi');
    } else say('Trip too short to save');
    if (station !== undefined) {
      setFillStation(station);
      setScreen('fill');
    } else setScreen('history');
  };

  const showNav = screen === 'home' || screen === 'history';
  return (
    <View style={st.root}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={st.scroll} keyboardShouldPersistTaps="handled">
        <View style={st.col}>
          {screen === 'car' && <CarScreen data={data} update={update} onDone={() => { say('Car saved'); setScreen('home'); }} />}
          {screen === 'home' && (
            <HomeScreen data={data} mpg={mpg} price={price} cal={cal} tracker={tracker} onStart={startTrip} go={setScreen}
              addEntry={addEntry} say={say} onFill={() => { setFillStation(null); setScreen('fill'); }} />
          )}
          {screen === 'live' && (
            <LiveScreen tracker={tracker} baseMpg={baseMpg} k={cal.k} price={price} car={car}
              onEnd={() => finishTrip()} onFuel={(stn) => finishTrip(stn || tracker.nearestStation() || null)} />
          )}
          {screen === 'fill' && (
            <FillScreen data={data} price={price} station={fillStation} update={update} addEntry={addEntry} say={say}
              onDone={() => setScreen('history')} onCancel={() => setScreen('home')} />
          )}
          {screen === 'manual' && (
            <ManualTrip mpg={mpg} price={price} onSave={(t) => { addEntry(t); say('Trip saved'); setScreen('history'); }}
              onCancel={() => setScreen('home')} />
          )}
          {screen === 'odo' && (
            <OdoScreen data={data} onSave={(o) => { addEntry({ kind: 'odo', date: todayKey(), odo: o }); say('Odometer saved'); setScreen('history'); }}
              onCancel={() => setScreen('history')} />
          )}
          {screen === 'history' && <HistoryScreen data={data} cal={cal} price={price} update={update} say={say} go={setScreen} />}
        </View>
      </ScrollView>
      {showNav && (
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

// ---------- car setup: reg → "Is this your car?" → details ----------
const carName = (v) => [v && v.make, v && v.model].filter(Boolean).join(' ') || 'Your car';
const carLine = (v) => [v.colour, v.fuelLabel || (v.fuel && v.fuel[0].toUpperCase() + v.fuel.slice(1)),
  v.engineCc ? (v.engineCc / 1000).toFixed(1) + ' litre' : null, v.year].filter(Boolean).join(' · ');

function Plate({ value, onChangeText }) {
  return (
    <View style={st.plateBox}>
      <View style={st.plateFlag}><Text style={st.plateFlagText}>UK</Text></View>
      <TextInput value={value} onChangeText={(t) => onChangeText(t.toUpperCase())} placeholder="AB12 CDE" placeholderTextColor="#8A7A2A"
        autoCapitalize="characters" autoCorrect={false} accessibilityLabel="Registration" style={st.plateInput} maxLength={9} />
    </View>
  );
}

function CarScreen({ data, update, onDone }) {
  const editing = !!data.car;
  const [stage, setStage] = useState(editing ? 'details' : 'reg'); // reg | looking | confirm | details
  const [reg, setReg] = useState((data.car && data.car.reg) || '');
  const [found, setFound] = useState(null);
  const [note, setNote] = useState(null);
  const lookupOn = !!VEHICLE_LOOKUP_URL;

  const find = async () => {
    const clean = reg.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (clean.length < 2) { setNote('Enter your registration first.'); return; }
    if (!lookupOn) { setNote(null); setFound(null); setStage('details'); return; }
    setNote(null);
    setStage('looking');
    try {
      const res = await fetch(VEHICLE_LOOKUP_URL.replace(/\/$/, '') + '/vehicle?reg=' + encodeURIComponent(clean));
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.found) { setFound(body); setStage('confirm'); return; }
      setNote(res.ok ? 'We couldn’t find ' + clean + '. Check the reg, or enter your car’s details yourself.'
        : body.error || 'The lookup isn’t working right now. You can enter your car’s details yourself.');
    } catch (e) {
      setNote('The lookup isn’t working right now. You can enter your car’s details yourself.');
    }
    setStage('reg');
  };

  if (stage === 'details') {
    return <CarDetails data={data} update={update} onDone={onDone} found={found} regInit={reg}
      onLookup={lookupOn ? () => { setFound(null); setStage('reg'); } : null} />;
  }

  return (
    <View style={st.gap}>
      <Brand />
      {stage === 'confirm' && found ? (
        <>
          <Label>We found</Label>
          <View style={[st.card, { gap: 6 }]}>
            <Text style={st.plateSmall}>{found.reg}</Text>
            <Text style={[st.h1, { fontSize: 28 }]}>{carName(found)}</Text>
            <Text style={st.body}>{carLine(found)}</Text>
            {found.mileage && found.mileage.lastReading ? (
              <Text style={st.small}>
                Last MOT: {found.mileage.lastReading.toLocaleString('en-GB')} miles ({new Date(found.mileage.lastDate).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })})
                {found.mileage.perYear ? ' · about ' + (Math.round(found.mileage.perYear / 500) * 500).toLocaleString('en-GB') + ' miles a year' : ''}
              </Text>
            ) : null}
          </View>
          <Text style={st.h1}>Is this your car?</Text>
          {found.fuel === 'electric' ? <Text style={st.warn}>This looks like an electric car. Miles & Pence only costs petrol and diesel for now.</Text> : null}
          <Btn title="Yes, that's my car" onPress={() => setStage('details')} />
          <Btn kind="quiet" title="No, that's not it" onPress={() => { setFound(null); setNote('Check the reg and try again, or enter your car’s details yourself.'); setStage('reg'); }} />
        </>
      ) : (
        <>
          <Text style={st.h1}>What do you drive?</Text>
          <Text style={st.body}>{lookupOn ? 'Enter your reg and we’ll find your car.' : 'Enter your reg to get started.'}</Text>
          <Plate value={reg} onChangeText={setReg} />
          {note ? <Text style={st.warn}>{note}</Text> : null}
          <Btn title={stage === 'looking' ? 'Looking up…' : lookupOn ? 'Find my car' : 'Continue'} onPress={find} disabled={stage === 'looking'} />
          {lookupOn ? <Btn kind="quiet" title="Enter details myself" onPress={() => { setFound(null); setStage('details'); }} /> : null}
        </>
      )}
    </View>
  );
}

function CarDetails({ data, update, onDone, found, regInit, onLookup }) {
  const c = data.car || {};
  const known = found || (c.make ? c : null);
  const [reg, setReg] = useState(regInit || c.reg || '');
  const [fuel, setFuel] = useState(found && (found.fuel === 'diesel' ? 'diesel' : found.fuel ? 'petrol' : null) || c.fuel || 'petrol');
  const [grade, setGrade] = useState(c.grade || 'standard');
  const [co2, setCo2] = useState(found && found.co2 ? String(found.co2) : c.co2 != null ? String(c.co2) : '');
  const [mpgIn, setMpgIn] = useState(c.mpg != null ? String(c.mpg) : '');
  const [priceIn, setPriceIn] = useState(c.price != null ? String(c.price) : '');
  const draft = { fuel, grade, co2: num(co2), mpg: num(mpgIn), price: num(priceIn) };
  const off = officialMpg(draft);
  const ppm = pencePerMile(off, draft.price);
  const grades = fuel === 'diesel'
    ? [['standard', 'Standard diesel'], ['premium', 'Premium diesel']]
    : [['standard', 'Unleaded (E10)'], ['premium', 'Super (E5)']];
  return (
    <View style={st.gap}>
      <Brand />
      <Text style={st.h1}>{known ? carName(known) : 'Your car'}</Text>
      {known ? <Text style={[st.body, { marginTop: -8 }]}>{carLine(known)}</Text> : null}
      <Text style={st.body}>
        {found && found.co2
          ? 'We’ve filled in your CO₂ figure. Add the price you usually pay and you’re ready.'
          : 'Your CO₂ figure is on your V5C logbook or any free reg-check site. We turn it into an mpg, then adjust it to your real driving as fill-ups come in.'}
      </Text>
      <Field label="Registration" value={reg} onChangeText={setReg} placeholder="AB12 CDE" upper />
      {onLookup ? <Btn kind="quiet" title="Look up a different reg" onPress={onLookup} /> : null}
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
      <View>
        <Text style={st.fieldLabel}>What you usually buy</Text>
        <View style={st.seg}>
          {grades.map(([g, t]) => (
            <Pressable key={g} accessibilityRole="button" accessibilityState={{ selected: grade === g }} onPress={() => setGrade(g)}
              style={[st.segBtn, grade === g && st.segOn]}>
              <Text style={[st.segText, grade === g && { color: C.ink }]}>{t}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <View style={st.row}>
        <Field style={st.flex} label="CO₂ (g/km)" value={co2} onChangeText={setCo2} placeholder="e.g. 117" keyboard="decimal-pad" />
        <Field style={st.flex} label="Or your own mpg" value={mpgIn} onChangeText={setMpgIn} placeholder="Overrides CO₂" keyboard="decimal-pad" />
      </View>
      <Field label="Usual price (p per litre)" value={priceIn} onChangeText={setPriceIn} placeholder="e.g. 169.9" keyboard="decimal-pad" />
      <View style={st.card}>
        {off ? (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
              <Mono style={{ fontSize: 44, fontWeight: '700', color: C.amber }}>{off.toFixed(1)}</Mono>
              <Text style={[st.body, { color: C.ink, fontWeight: '700' }]}>mpg official</Text>
            </View>
            <Text style={st.small}>{ppm ? 'About ' + ppm.toFixed(1) + 'p a mile at ' + draft.price + 'p/L' : 'Add a price to see cost per mile'}</Text>
          </>
        ) : <Text style={st.small}>Enter a CO₂ figure or an mpg to see your cost per mile.</Text>}
      </View>
      <Btn title="Save car" disabled={!off} onPress={() => {
        const id = known ? { make: known.make, model: known.model, colour: known.colour, year: known.year, engineCc: known.engineCc,
          fuelLabel: known.fuelLabel, mileage: known.mileage || null } : {};
        update((d) => ({ ...d, car: { reg: reg.trim().toUpperCase(), ...id, ...draft } }));
        onDone();
      }} />
    </View>
  );
}

function OdoPrompt({ addEntry, say }) {
  const [odo, setOdo] = useState('');
  const v = num(odo);
  return (
    <View style={[st.card, { borderColor: C.amber }]}>
      <Label>Monthly odometer check</Label>
      <Text style={st.body}>What does your mileage say today? Once a month keeps your figures honest and catches trips the GPS missed.</Text>
      <View style={[st.row, { alignItems: 'flex-end' }]}>
        <Field style={st.flex} label="Odometer (miles)" value={odo} onChangeText={setOdo} placeholder="e.g. 48213" keyboard="number-pad" />
        <Btn title="Save" disabled={!v} onPress={() => { addEntry({ kind: 'odo', date: todayKey(), odo: Math.round(v) }); say('Odometer saved'); }} style={{ minWidth: 96 }} />
      </View>
    </View>
  );
}

function HomeScreen({ data, mpg, price, cal, tracker, onStart, go, onFill, addEntry, say }) {
  const s = monthSummary(data.car, data.entries, todayKey().slice(0, 7));
  const ppm = pencePerMile(mpg, price);
  const insecure = Platform.OS === 'web' && typeof window !== 'undefined' && !window.isSecureContext;
  const needOdo = needsOdoThisMonth(data.entries, todayKey().slice(0, 7));
  return (
    <View style={st.gap}>
      <Brand reg={data.car && data.car.reg} />
      <View>
        <Label>{monthName()} so far</Label>
        <Mono style={{ fontSize: 54, fontWeight: '700', letterSpacing: -2 }}>{gbp(s.est)}</Mono>
        <Text style={st.body}>
          {s.miles ? Math.round(s.miles * 10) / 10 + ' miles · ' + s.litres.toFixed(1) + ' litres' + (s.mpg ? ' · ' + s.mpg.toFixed(1) + ' mpg' : '') : 'No trips yet this month'}
        </Text>
      </View>
      <Btn title={tracker.status === 'starting' ? 'Finding you…' : 'Start a trip'} onPress={onStart} disabled={tracker.status === 'starting'} style={{ height: 64 }} />
      {tracker.status === 'denied' ? (
        <Text style={st.warn}>Location is switched off for this site. On iPhone: Settings › Privacy & Security › Location Services › Safari Websites › While Using, then try again.</Text>
      ) : null}
      {tracker.error ? <Text style={st.warn}>GPS problem: {tracker.error}</Text> : null}
      {insecure ? <Text style={st.warn}>GPS only works when this page is opened from its https:// address.</Text> : null}
      <Text style={[st.small, { textAlign: 'center' }]}>
        Keep this open on a phone mount. If the phone locks, unlock it and the trip picks up again, filling in the miles you missed.
        {Platform.OS === 'web' ? ' For best results set Settings › Display & Brightness › Auto-Lock to Never while driving.' : ''}
      </Text>
      {needOdo ? <OdoPrompt addEntry={addEntry} say={say} /> : null}
      <View style={st.stats}>
        <Stat label="Per mile" value={ppm ? ppm.toFixed(1) + 'p' : '–'} sub={price ? 'at ' + price + 'p/L' : 'add a price'} />
        <Stat label={cal.realMpg ? 'Your real mpg' : 'Official mpg'} value={mpg ? mpg.toFixed(1) : '–'}
          sub={cal.realMpg ? 'from your fill-ups' : 'until 2 full fill-ups'} />
      </View>
      <View style={st.row}>
        <Btn kind="quiet" title="Log a fill-up" onPress={onFill} style={st.flex} />
        <Btn kind="quiet" title="Add trip by hand" onPress={() => go('manual')} style={st.flex} />
      </View>
    </View>
  );
}

function LiveScreen({ tracker, baseMpg, k, price, car, onEnd, onFuel }) {
  const stationPrice = livePrice(tracker.station, car);
  const litres = tracker.litres * k;
  const cost = price ? (litres * price) / 100 : null;
  const tripMpg = litres > 0.01 && tracker.miles > 0.1 ? tracker.miles / (litres / LITRES_PER_GALLON) : null;
  const milesPerLitre = litres > 0.01 && tracker.miles > 0.1 ? tracker.miles / litres : null;
  const moving = tracker.speedMph >= 3;
  const nowMpg = moving ? mpgAtSpeed(tracker.speedMph, baseMpg, k) : null;
  const gpsOk = tracker.accuracy != null && tracker.accuracy <= 35;
  return (
    <View style={st.gap}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: gpsOk ? C.good : C.amber }} />
        <Label>{gpsOk ? 'Trip in progress' : 'Waiting for a good GPS signal'}</Label>
      </View>

      {tracker.station ? (
        <View style={[st.card, { borderColor: C.amber, borderWidth: 2 }]}>
          <Label style={{ color: C.amber }}>You've stopped at a fuel station</Label>
          <Text style={[st.h2, { fontSize: 22 }]}>Refuelling at {tracker.station.name}?</Text>
          {stationPrice ? (
            <Text style={st.body}>{fuelLabel(car)} here: <Text style={{ color: C.amber, fontWeight: '800' }}>{stationPrice}p</Text> a litre</Text>
          ) : null}
          <View style={st.row}>
            <Btn title="Yes, refuelling" onPress={() => onFuel(tracker.station)} style={st.flex} />
            <Btn kind="quiet" title="No" onPress={tracker.dismissStation} style={st.flex} />
          </View>
        </View>
      ) : null}

      <View style={{ alignItems: 'center', paddingVertical: 20, gap: 4 }}>
        <Text style={st.body}>This trip has cost</Text>
        <Mono style={{ fontSize: 76, fontWeight: '700', color: C.amber, letterSpacing: -3 }}>{cost != null ? gbp(cost) : '–'}</Mono>
        <Text style={st.small}>{fmtTime(tracker.elapsed)} driving</Text>
      </View>
      <View style={st.stats3}>
        <Stat label="Miles" value={tracker.miles.toFixed(1)} />
        <Stat label="Litres" value={litres.toFixed(2)} />
        <Stat label="mph" value={String(Math.round(tracker.speedMph))} />
      </View>
      <View style={st.stats3}>
        <Stat label="Right now" value={nowMpg ? Math.round(nowMpg) : 'Idle'} sub={nowMpg ? 'mpg at this speed' : 'engine running'} />
        <Stat label="Trip mpg" value={tripMpg ? tripMpg.toFixed(1) : '–'} />
        <Stat label="Per litre" value={milesPerLitre ? milesPerLitre.toFixed(1) : '–'} sub="miles" />
      </View>
      <Text style={[st.small, { textAlign: 'center' }]}>
        GPS ±{tracker.accuracy != null ? tracker.accuracy + ' m' : '…'}
        {tracker.stationCount != null ? ' · ' + tracker.stationCount + ' fuel stations nearby' + (tracker.stationSource === 'fuelfinder' ? ', live prices' : '') : ''}
      </Text>
      {tracker.stationError ? <Text style={[st.small, { textAlign: 'center' }]}>{tracker.stationError}</Text> : null}
      {tracker.lastGap && Date.now() - tracker.lastGap.at < 120000 ? (
        <View style={[st.card, { paddingVertical: 12 }]}>
          <Text style={[st.body, { color: C.ink }]}>
            GPS was paused for {tracker.lastGap.minutes ? tracker.lastGap.minutes + ' min' : 'a moment'}. Added an estimated {tracker.lastGap.miles.toFixed(1)} mi.
          </Text>
        </View>
      ) : tracker.gapMiles >= 0.1 ? (
        <Text style={[st.small, { textAlign: 'center' }]}>{tracker.gapMiles.toFixed(1)} mi of this trip estimated while GPS was paused</Text>
      ) : null}
      {tracker.error ? <Text style={st.warn}>GPS problem: {tracker.error}</Text> : null}
      <Btn kind="light" title="I'm at a fuel station" onPress={() => onFuel(tracker.station || null)} />
      <Btn kind="quiet" title="End trip" onPress={onEnd} />
    </View>
  );
}

function FillScreen({ data, price, station, update, addEntry, say, onDone, onCancel }) {
  const known = station && data.stations[station.id];
  const live = livePrice(station, data.car);
  const [spend, setSpend] = useState(null);
  const [other, setOther] = useState('');
  const [p, setP] = useState(String(live || (known && known.lastPrice) || price || ''));
  const [odo, setOdo] = useState('');
  const [name, setName] = useState(station ? station.name : '');
  const [full, setFull] = useState(false);
  const sp = spend === 'other' ? num(other) : spend;
  const pr = num(p);
  const litres = sp && pr ? sp / (pr / 100) : null;

  const save = () => {
    if (!sp || !pr) return;
    if (station) {
      update((d) => ({ ...d, stations: { ...d.stations, [station.id]: {
        name: station.name, latitude: station.latitude, longitude: station.longitude,
        lastPrice: pr, visits: ((d.stations[station.id] || {}).visits || 0) + 1 } } }));
    }
    addEntry({ kind: 'fill', date: todayKey(), spend: Math.round(sp * 100) / 100, price: pr, litres: Math.round(litres * 100) / 100,
      odo: num(odo), station: name.trim(), stationId: station ? station.id : null, full });
    say('Fill-up saved: ' + litres.toFixed(1) + ' L');
    onDone();
  };

  return (
    <View style={st.gap}>
      <Brand reg={data.car && data.car.reg} />
      <View style={{ gap: 4 }}>
        {station ? <Label>{station.name}</Label> : null}
        <Text style={st.h1}>How much did you spend?</Text>
      </View>
      <View style={st.chips}>
        {SPEND_CHIPS.map((v) => (
          <Pressable key={v} accessibilityRole="button" accessibilityState={{ selected: spend === v }} onPress={() => setSpend(v)}
            style={[st.chip, spend === v && st.chipOn]}>
            <Mono style={[{ fontSize: 20, fontWeight: '700' }, spend === v && { color: C.onAmber }]}>£{v}</Mono>
          </Pressable>
        ))}
        <Pressable accessibilityRole="button" accessibilityState={{ selected: spend === 'other' }} onPress={() => setSpend('other')}
          style={[st.chip, st.chipWide, spend === 'other' && st.chipOn]}>
          <Text style={[st.btnTextQuiet, spend === 'other' && { color: C.onAmber }]}>Other amount</Text>
        </Pressable>
      </View>
      {spend === 'other' ? <Field label="Amount (£)" value={other} onChangeText={setOther} placeholder="e.g. 47.32" keyboard="decimal-pad" /> : null}

      <View style={[st.card, { alignItems: 'center' }]}>
        <Mono style={{ fontSize: 46, fontWeight: '700', color: litres ? C.amber : C.muted }}>{litres ? litres.toFixed(1) : '–'}</Mono>
        <Text style={st.small}>{litres ? 'litres added' : 'Pick an amount to see the litres'}</Text>
      </View>

      <Field label={station ? 'Price here (p per litre)' : 'Price (p per litre)'} value={p} onChangeText={setP} placeholder="169.9" keyboard="decimal-pad" />
      <Text style={[st.small, { marginTop: -8 }]}>
        {live
          ? 'Live ' + fuelLabel(data.car).toLowerCase() + ' price from Fuel Finder' + (station.updated ? ', updated ' + ago(station.updated) : '') + '. Change it if the pump says otherwise.'
          : known && known.lastPrice
            ? 'Last time here you paid ' + known.lastPrice + 'p. Check the pump and change it if needed.'
            : 'Check the pump display and change this if needed.'}
      </Text>
      {!station ? <Field label="Station" value={name} onChangeText={setName} placeholder="e.g. Tesco, Leigh" /> : null}
      <View style={st.switchRow}>
        <View style={{ flex: 1 }}>
          <Text style={st.switchText}>Filled to full</Text>
          <Text style={st.small}>Brimming the tank twice lets us measure your real mpg.</Text>
        </View>
        <Switch value={full} onValueChange={setFull} trackColor={{ true: C.amber, false: C.line }} accessibilityLabel="Filled to full" />
      </View>
      {full ? <Field label="Odometer (miles, optional)" value={odo} onChangeText={setOdo} placeholder="e.g. 48213" keyboard="number-pad" /> : null}
      <Btn title="Save fill-up" onPress={save} disabled={!sp || !pr} />
      <Btn kind="quiet" title="Not refuelling after all" onPress={onCancel} />
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

function OdoScreen({ data, onSave, onCancel }) {
  const [odo, setOdo] = useState('');
  const v = num(odo);
  return (
    <View style={st.gap}>
      <Brand reg={data.car && data.car.reg} />
      <Text style={st.h1}>Odometer reading</Text>
      <Text style={st.body}>We compare this with the miles the app logged since your last reading.</Text>
      <Field label="Odometer (miles)" value={odo} onChangeText={setOdo} placeholder="e.g. 48213" keyboard="number-pad" />
      <Btn title="Save reading" disabled={!v} onPress={() => onSave(Math.round(v))} />
      <Btn kind="quiet" title="Cancel" onPress={onCancel} />
    </View>
  );
}

function OdoCard({ data }) {
  const o = odoCheck(data.car, data.entries);
  if (!o) {
    return (
      <View style={st.card}>
        <Label>Odometer check</Label>
        <Text style={st.small}>After two readings (monthly check-ins or full fill-ups with a reading) we'll show how many miles the app caught.</Text>
      </View>
    );
  }
  if (o.error) return <View style={st.card}><Label>Odometer check</Label><Text style={st.warn}>{o.error}</Text></View>;
  const pct = Math.round(o.coverage * 100);
  return (
    <View style={st.card}>
      <Label>Odometer check · {niceDate(o.a.date)} to {niceDate(o.b.date)}</Label>
      <View style={st.between}><Text style={st.body}>Odometer says</Text><Mono style={{ fontSize: 17 }}>{o.actual} mi</Mono></View>
      <View style={st.between}><Text style={st.body}>App logged</Text><Mono style={{ fontSize: 17 }}>{Math.round(o.logged * 10) / 10} mi</Mono></View>
      <View style={st.between}>
        <Text style={st.body}>Caught</Text>
        <Mono style={{ fontSize: 17, fontWeight: '700', color: pct >= 95 && pct <= 105 ? C.good : C.amber }}>{pct}%</Mono>
      </View>
      <Text style={st.small}>
        {pct > 105
          ? 'The app logged more than the odometer. GPS may be over-counting, or a reading was mistyped.'
          : o.untracked >= 1
            ? Math.round(o.untracked) + ' miles weren’t tracked' + (o.untrackedCost != null ? ', about ' + gbp(o.untrackedCost) + ' of fuel.' : '.')
            : 'Every mile accounted for.'}
      </Text>
    </View>
  );
}

function HistoryScreen({ data, cal, price, update, say, go }) {
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
    const text = JSON.stringify({ exported: new Date().toISOString(), calibration: cal, ...data }, null, 1);
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ title: 'Miles & Pence data', text });
      } else if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
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
        <Label>Does it add up? ({monthName()})</Label>
        <View style={st.between}><Text style={st.body}>Trips, estimated</Text><Mono style={{ fontSize: 17 }}>{gbp(s.est)}</Mono></View>
        <View style={st.between}><Text style={st.body}>Fuel bought</Text><Mono style={{ fontSize: 17 }}>{gbp(s.bought)}</Mono></View>
        <Text style={st.small}>
          {cal.calibrated
            ? 'The speed model has been tuned to your fill-ups: your car uses ' + Math.round(Math.abs(cal.k - 1) * 100) + '% ' + (cal.k >= 1 ? 'more' : 'less') + ' than the official figure suggests.'
            : 'Over a few weeks these should end up close. Two full fill-ups tune the model to your car.'}
        </Text>
      </View>
      <OdoCard data={data} />
      <Btn kind="quiet" title="Add odometer reading" onPress={() => go('odo')} />
      {list.length === 0 ? (
        <View style={st.empty}><Text style={[st.body, { color: C.ink, fontWeight: '700' }]}>Nothing logged yet</Text><Text style={st.small}>Go back to Home and start a trip.</Text></View>
      ) : list.map((e) => {
        let title, meta, amount, color = C.ink;
        if (e.kind === 'trip') {
          const f = tripFuel(e, data.car, data.entries, cal, price);
          const tMpg = f.litres > 0 ? e.miles / (f.litres / LITRES_PER_GALLON) : null;
          title = e.name || 'Trip';
          const b = e.bands;
          const mix = b && e.miles ? ' · ' + [['town', 'town'], ['aroad', 'A-road'], ['motorway', 'mway']]
            .filter(([kk]) => b[kk] >= 0.1).map(([kk, n]) => Math.round((b[kk] / e.miles) * 100) + '% ' + n).join(', ') : '';
          meta = niceDate(e.date) + ' · ' + e.miles + ' mi' + (e.seconds ? ' · ' + Math.round(e.seconds / 60) + ' min' : '') +
            (tMpg ? ' · ' + tMpg.toFixed(0) + ' mpg' : '') + (e.source === 'gps' ? mix : ' · by hand') +
            (e.gapMiles >= 0.1 ? ' · ' + e.gapMiles.toFixed(1) + ' mi estimated (GPS paused)' : '');
          amount = f.cost != null ? gbp(f.cost) : '–';
        } else if (e.kind === 'fill') {
          title = e.station || 'Fill-up';
          meta = niceDate(e.date) + ' · ' + (e.litres || 0).toFixed(1) + ' L at ' + e.price + 'p' + (e.full ? ' · full' : '') + (e.odo ? ' · ' + e.odo + ' mi' : '');
          amount = gbp(e.spend);
          color = C.amber;
        } else {
          title = 'Odometer';
          meta = niceDate(e.date);
          amount = e.odo + ' mi';
          color = C.muted;
        }
        const kind = e.kind === 'trip' ? 'TRIP  ' : e.kind === 'fill' ? 'FILL-UP  ' : 'CHECK  ';
        return (
          <View key={e.id} style={st.item}>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text style={st.itemTitle}><Text style={st.kind}>{kind}</Text>{title}</Text>
              <Text style={st.small}>{meta}</Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 2 }}>
              <Mono style={{ fontSize: 17, fontWeight: '700', color }}>{amount}</Mono>
              <Pressable accessibilityRole="button" onPress={() => remove(e.id)} hitSlop={10}>
                <Text style={[st.small, { textDecorationLine: 'underline', color: armed === e.id ? C.warn : C.muted }]}>{armed === e.id ? 'Tap again to delete' : 'Delete'}</Text>
              </Pressable>
            </View>
          </View>
        );
      })}
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
  plateBox: { flexDirection: 'row', height: 72, borderRadius: 10, overflow: 'hidden', backgroundColor: C.plate, borderWidth: 2, borderColor: '#1A1A1A' },
  plateFlag: { width: 40, backgroundColor: '#1E4FA8', alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 8 },
  plateFlagText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  plateInput: { flex: 1, minWidth: 0, color: '#111111', fontFamily: MONO, fontWeight: '700', fontSize: 32, textAlign: 'center', letterSpacing: 3 },
  plateSmall: { alignSelf: 'flex-start', fontFamily: MONO, fontWeight: '700', fontSize: 14, backgroundColor: C.plate, color: '#111', paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6, overflow: 'hidden', letterSpacing: 1 },
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
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: { flexBasis: '30%', flexGrow: 1, height: 58, borderRadius: 14, borderWidth: 1, borderColor: C.line, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center' },
  chipWide: { flexBasis: '100%' },
  chipOn: { backgroundColor: C.amber, borderColor: C.amber },
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
