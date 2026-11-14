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
import { driverScore, hasScore, scoreLabel, scoreTrip, TIP_LIBRARY } from './src/score';
import { APP_VERSION, CONTACT, DELETE_BY, NOTICE_DATE, NOTICE_VERSION, TEST_END, VEHICLE_LOOKUP_URL } from './src/config';
import { leaveTest, newTester, shareNow, sharingAvailable } from './src/sharing';

const needsAgreement = (d) => !(d.test && d.test.left) && !(d.test && d.test.agreedAt && d.test.noticeVersion >= NOTICE_VERSION);

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
  const [tripView, setTripView] = useState(null);
  const toastTimer = useRef(null);

  const car = data ? data.car : null;
  const entries = data ? data.entries : [];
  const cal = useMemo(() => calibrate(car, entries), [car, entries]);
  const baseMpg = officialMpg(car) || cal.realMpg;
  const tracker = useTripTracker({ baseMpg, fuel: (car && car.fuel) || 'petrol' });

  useEffect(() => {
    loadData().then((d) => {
      setData(d);
      if (!d.welcomed && !d.car) setScreen('welcome');
      else if (needsAgreement(d)) setScreen('agree');
      else if (!officialMpg(d.car)) setScreen('car');
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

  // Share a summary with the test team shortly after anything changes.
  const [share, setShare] = useState({ state: 'idle', at: null });
  useEffect(() => {
    if (!data || !data.test || !data.test.testerId || data.test.left) return;
    if (!sharingAvailable()) { setShare({ state: 'waiting', at: null }); return; }
    const t = setTimeout(() => {
      setShare((s) => ({ ...s, state: 'sending' }));
      shareNow(data).then((at) => setShare({ state: 'ok', at })).catch(() => setShare((s) => ({ ...s, state: 'failed' })));
    }, 3000);
    return () => clearTimeout(t);
  }, [data]);

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
    const id = newId();
    const saved = r.miles >= 0.05;
    if (saved) {
      addEntry({ id, kind: 'trip', date: todayKey(), source: 'gps', name: station ? 'To ' + station.name : '',
        miles: Math.round(r.miles * 10) / 10, litres: r.litres, seconds: r.seconds, idleSeconds: r.idleSeconds,
        bands: r.bands, gapMiles: r.gapMiles, behaviour: r.behaviour, start: r.start, end: r.end });
      say('Trip saved: ' + r.miles.toFixed(1) + ' mi');
    } else say('Trip too short to save');
    if (station !== undefined) {
      setFillStation(station);
      setScreen('fill');
    } else if (saved) {
      setTripView(id); // journey snapshot, shown now the car has stopped
      setScreen('trip');
    } else setScreen('history');
  };

  const showNav = screen === 'home' || screen === 'history' || screen === 'tips';
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
          {screen === 'history' && <HistoryScreen data={data} cal={cal} price={price} update={update} say={say} go={setScreen} share={share}
            onOpenTrip={(id) => { setTripView(id); setScreen('trip'); }} />}
          {screen === 'trip' && (
            <TripScreen trip={data.entries.find((x) => x.id === tripView)} data={data} cal={cal} price={price} update={update}
              onDone={() => setScreen('history')} onTips={() => setScreen('tips')} />
          )}
          {screen === 'tips' && <TipsScreen data={data} cal={cal} price={price} />}
          {screen === 'welcome' && <WelcomeScreen onDone={() => { update((d) => ({ ...d, welcomed: true })); setScreen('agree'); }} />}
          {screen === 'agree' && (
            <AgreeScreen onPrivacy={() => setScreen('privacy-from-agree')} onAgree={(insights) => {
              const now = new Date().toISOString();
              update((d) => ({ ...d, welcomed: true, test: { ...newTester(), ...(d.test && d.test.testerId ? { testerId: d.test.testerId, secret: d.test.secret } : {}),
                agreedAt: now, noticeVersion: NOTICE_VERSION, insights: !!insights, insightsAt: now } }));
              setScreen(officialMpg(data.car) ? 'home' : 'car');
            }} />
          )}
          {(screen === 'privacy' || screen === 'privacy-from-agree') && (
            <PrivacyScreen data={data} fromAgree={screen === 'privacy-from-agree'} share={share}
              onSetInsights={(v) => update((d) => ({ ...d, test: { ...d.test, insights: v, insightsAt: new Date().toISOString() } }))}
              onBack={() => setScreen(screen === 'privacy-from-agree' ? 'agree' : 'history')}
              onLeave={async () => {
                try {
                  await leaveTest(data);
                  update((d) => ({ ...d, test: { left: true, leftAt: new Date().toISOString() } }));
                  say('You’ve left the test. Your shared data is deleted.');
                  setScreen('home');
                } catch (e) {
                  say('Couldn’t reach the test service. Try again when you have signal.');
                }
              }} />
          )}
          {screen === 'feedback' && <FeedbackScreen data={data} cal={cal} price={price} say={say} onDone={() => setScreen('home')} />}
        </View>
      </ScrollView>
      {showNav && (
        <View style={st.nav}>
          {[['home', 'Home'], ['history', 'History'], ['tips', 'Tips'], ['car', 'Car']].map(([k, t]) => (
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
  // Offer "Find my car" only once the service has vehicle-data credentials.
  const [lookupOn, setLookupOn] = useState(false);
  useEffect(() => {
    if (!VEHICLE_LOOKUP_URL) return;
    let live = true;
    fetch(VEHICLE_LOOKUP_URL + '/health').then((r) => r.json()).then((h) => { if (live) setLookupOn(!!(h.mot || h.dvla)); }).catch(() => {});
    return () => { live = false; };
  }, []);

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
        <Text style={st.warn}>Location is blocked for this site. On iPhone: Settings › Privacy & Security › Location Services › Safari Websites › While Using the App, with Precise Location on. Then in Safari, tap the icon at the left of the address bar › Website Settings › Location › Allow, and reload.</Text>
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
      <DriverScoreCard data={data} cal={cal} price={price} onTips={() => go('tips')} />
      <View style={st.row}>
        <Btn kind="quiet" title="Log a fill-up" onPress={onFill} style={st.flex} />
        <Btn kind="quiet" title="Add trip by hand" onPress={() => go('manual')} style={st.flex} />
      </View>
      <Pressable accessibilityRole="button" onPress={() => go('feedback')} style={{ alignSelf: 'center', minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 }}>
        <Text style={[st.body, { color: C.amber, fontWeight: '700' }]}>Send feedback</Text>
      </Pressable>
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
      {!gpsOk && (tracker.gpsError || tracker.elapsed >= 15) ? (
        <View style={[st.card, { borderColor: C.amber, gap: 6 }]}>
          {tracker.gpsError && tracker.gpsError.kind === 'denied' ? (
            <>
              <Text style={[st.h2, { fontSize: 16 }]}>Location is blocked for this site</Text>
              <Text style={st.body}>1. Settings › Privacy & Security › Location Services: turn it on, then set Safari Websites to While Using the App with Precise Location on.</Text>
              <Text style={st.body}>2. In Safari, tap the icon at the left of the address bar › Website Settings › Location › Allow.</Text>
              <Text style={st.body}>3. Reload the page and start the trip again.</Text>
            </>
          ) : tracker.accuracy == null ? (
            <>
              <Text style={[st.h2, { fontSize: 16 }]}>{tracker.gpsError && tracker.gpsError.kind === 'unavailable' ? 'Your phone can’t find its location' : 'No location from your phone yet'}</Text>
              <Text style={st.body}>Check Settings › Privacy & Security › Location Services is on, and Safari Websites is set to While Using the App with Precise Location on. If you’re indoors, step outside for a minute.</Text>
            </>
          ) : tracker.accuracy > 500 ? (
            <>
              <Text style={[st.h2, { fontSize: 16 }]}>Only a rough location (±{tracker.accuracy} m)</Text>
              <Text style={st.body}>Precise Location looks switched off. Turn it on in Settings › Privacy & Security › Location Services › Safari Websites › Precise Location.</Text>
            </>
          ) : (
            <>
              <Text style={[st.h2, { fontSize: 16 }]}>Weak signal (±{tracker.accuracy} m)</Text>
              <Text style={st.body}>Normal indoors or in a car park. It should settle within a minute outside. If it doesn’t, check Precise Location is on in Settings › Privacy & Security › Location Services › Safari Websites.</Text>
            </>
          )}
        </View>
      ) : null}

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

function HistoryScreen({ data, cal, price, update, say, go, share, onOpenTrip }) {
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
      <ShareStatus data={data} share={share} go={go} />
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
          if (hasScore(e)) meta += ' · score ' + scoreTrip(e, { car: data.car, cal, price }).score;
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
            <Pressable accessibilityRole={e.kind === 'trip' ? 'button' : undefined} disabled={e.kind !== 'trip'}
              onPress={() => onOpenTrip(e.id)} style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text style={st.itemTitle}><Text style={st.kind}>{kind}</Text>{title}</Text>
              <Text style={st.small}>{meta}</Text>
              {e.kind === 'trip' ? <Text style={[st.small, { color: C.amber, fontWeight: '700' }]}>View journey</Text> : null}
            </Pressable>
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
      <Btn kind="quiet" title="Send feedback" onPress={() => go('feedback')} />
      <Text style={[st.small, { marginTop: 8 }]}>Fuel prices contain public sector information licensed under the Open Government Licence v3.0.</Text>
    </View>
  );
}

// ---------- driver score, journey snapshot, tips ----------
const scoreColour = (s) => (s >= 85 ? C.good : s >= 70 ? C.amber : C.warn);
const PART_NAMES = { smooth: 'Smooth driving', speed: 'Speed', idle: 'Idling' };

function ScoreBar({ label, score, detail }) {
  return (
    <View style={{ gap: 4 }}>
      <View style={st.between}>
        <Text style={[st.body, { color: C.ink, fontWeight: '600' }]}>{label}</Text>
        <Mono style={{ fontSize: 15, fontWeight: '700', color: scoreColour(score) }}>{score}</Mono>
      </View>
      <View style={st.barTrack} accessibilityLabel={label + ' ' + score + ' out of 100'}>
        <View style={[st.barFill, { width: Math.max(2, score) + '%', backgroundColor: scoreColour(score) }]} />
      </View>
      {detail ? <Text style={st.small}>{detail}</Text> : null}
    </View>
  );
}

function BigScore({ score, caption }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
      <View style={[st.scoreRing, { borderColor: scoreColour(score) }]}>
        <Mono style={{ fontSize: 34, fontWeight: '700', letterSpacing: -1 }}>{score}</Mono>
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[st.h2, { fontSize: 22, color: scoreColour(score) }]}>{scoreLabel(score)}</Text>
        {caption ? <Text style={st.small}>{caption}</Text> : null}
      </View>
    </View>
  );
}

function TipCard({ tip }) {
  return (
    <View style={[st.card, { gap: 6 }]}>
      <Text style={[st.h2, { fontSize: 16 }]}>{tip.title}</Text>
      <Text style={st.body}>{tip.body}</Text>
    </View>
  );
}

function DriverScoreCard({ data, cal, price, onTips }) {
  const ds = driverScore(data.entries, { car: data.car, cal, price });
  if (!ds) {
    return (
      <View style={st.card}>
        <Label>Driver score</Label>
        <Text style={st.small}>Your score appears after your first GPS trip of half a mile or more. It rates smooth driving, speed and idling.</Text>
      </View>
    );
  }
  const trend = ds.trend == null ? 'Last 30 days · ' + ds.trips + (ds.trips === 1 ? ' trip' : ' trips')
    : (ds.trend > 0 ? 'Up ' + ds.trend : ds.trend < 0 ? 'Down ' + -ds.trend : 'No change') + ' on the 30 days before';
  return (
    <View style={[st.card, { gap: 14 }]}>
      <Label>Driver score · last 30 days</Label>
      <BigScore score={ds.score} caption={trend} />
      <View style={{ gap: 10 }}>
        {['smooth', 'speed', 'idle'].map((k) => <ScoreBar key={k} label={PART_NAMES[k]} score={ds.parts[k]} />)}
      </View>
      {ds.tips[0] ? <Text style={[st.body, { color: C.ink }]}>Top tip: {ds.tips[0].title.toLowerCase()}.</Text> : null}
      <Pressable accessibilityRole="button" onPress={onTips} style={{ minHeight: 44, justifyContent: 'center' }}>
        <Text style={[st.body, { color: C.amber, fontWeight: '700' }]}>Tips to improve</Text>
      </Pressable>
    </View>
  );
}

function TripScreen({ trip, data, cal, price, update, onDone, onTips }) {
  const [name, setName] = useState((trip && trip.name) || '');
  if (!trip) {
    return (
      <View style={st.gap}>
        <Brand />
        <Text style={st.body}>That trip has been deleted.</Text>
        <Btn kind="quiet" title="Back" onPress={onDone} />
      </View>
    );
  }
  const ctx = { car: data.car, cal, price };
  const f = tripFuel(trip, data.car, data.entries, cal, price);
  const tMpg = f.litres > 0 ? trip.miles / (f.litres / LITRES_PER_GALLON) : null;
  const sc = hasScore(trip) ? scoreTrip(trip, ctx) : null;
  const started = trip.createdAt ? new Date(trip.createdAt - (trip.seconds || 0) * 1000) : null;
  const when = niceDate(trip.date) + (started ? ', ' + started.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');
  const saveName = () => {
    const v = name.trim();
    if (v !== (trip.name || '')) update((d) => ({ ...d, entries: d.entries.map((e) => (e.id === trip.id ? { ...e, name: v } : e)) }));
  };
  return (
    <View style={st.gap}>
      <Brand reg={data.car && data.car.reg} />
      <View style={{ gap: 2 }}>
        <Label>Journey snapshot · {when}</Label>
        <Mono style={{ fontSize: 54, fontWeight: '700', letterSpacing: -2, color: C.amber }}>{f.cost != null ? gbp(f.cost) : '–'}</Mono>
        <Text style={st.body}>of fuel{f.cost != null && trip.miles ? ', ' + ((f.cost * 100) / trip.miles).toFixed(1) + 'p a mile' : ''}</Text>
      </View>
      <View style={st.stats3}>
        <Stat label="Miles" value={String(trip.miles)} />
        <Stat label="mpg" value={tMpg ? tMpg.toFixed(0) : '–'} />
        <Stat label="Minutes" value={trip.seconds ? String(Math.round(trip.seconds / 60)) : '–'} />
      </View>
      {sc ? (
        <View style={[st.card, { gap: 14 }]}>
          <Label>Driving score</Label>
          <BigScore score={sc.score} />
          <View style={{ gap: 12 }}>
            {sc.parts.map((p) => <ScoreBar key={p.key} label={p.label} score={p.score} detail={p.detail} />)}
          </View>
        </View>
      ) : (
        <View style={st.card}>
          <Text style={st.small}>
            {trip.source !== 'gps' ? 'Trips added by hand don’t get a driving score.'
              : !trip.behaviour ? 'Driving scores start from trips made with this version of the app.'
                : 'Driving scores are given for GPS trips of half a mile or more.'}
          </Text>
        </View>
      )}
      {sc && sc.tips.length ? (
        <View style={{ gap: 10 }}>
          <Label>{sc.tips[0].id === 'good' ? 'Nice one' : 'Tips from this journey'}</Label>
          {sc.tips.slice(0, 2).map((t) => <TipCard key={t.id} tip={t} />)}
        </View>
      ) : null}
      <View style={st.field}>
        <Text style={st.fieldLabel}>Name this journey</Text>
        <TextInput value={name} onChangeText={setName} onBlur={saveName} onSubmitEditing={saveName} placeholder="e.g. School run"
          placeholderTextColor="#6F827B" accessibilityLabel="Name this journey" style={st.input} />
      </View>
      <Text style={st.small}>Scores and savings are estimates from your phone’s GPS and the app’s fuel model. We only flag speed above 70 mph, the top UK limit; many roads have lower limits.</Text>
      <Btn title="Done" onPress={() => { saveName(); onDone(); }} />
      <Btn kind="quiet" title="More fuel-saving tips" onPress={() => { saveName(); onTips(); }} />
    </View>
  );
}

function TipsScreen({ data, cal, price }) {
  const ds = driverScore(data.entries, { car: data.car, cal, price });
  const saving = ds ? ds.savings.idle + ds.savings.speed : 0;
  return (
    <View style={st.gap}>
      <Brand reg={data.car && data.car.reg} />
      <Text style={st.h1}>Fuel-saving tips</Text>
      {ds ? (
        <>
          <View style={[st.card, { gap: 10 }]}>
            <Label>Your driving · last 30 days</Label>
            <BigScore score={ds.score} caption={Math.round(ds.miles) + ' miles over ' + ds.trips + (ds.trips === 1 ? ' trip' : ' trips')} />
            {saving >= 0.05 ? (
              <Text style={[st.body, { color: C.ink }]}>Idling and speeds above 70 mph cost you about {gbp(saving)} in fuel.</Text>
            ) : null}
          </View>
          {ds.tips.length ? (
            <View style={{ gap: 10 }}>
              <Label>For you</Label>
              {ds.tips.slice(0, 3).map((t) => <TipCard key={t.id} tip={t} />)}
            </View>
          ) : (
            <Text style={st.body}>No problem areas in your last 30 days. The tips below can still help.</Text>
          )}
        </>
      ) : (
        <Text style={st.body}>Personal tips appear after your first GPS trip. Meanwhile, these work for every driver.</Text>
      )}
      {TIP_LIBRARY.map((g) => (
        <View key={g.group} style={{ gap: 10 }}>
          <Label style={{ marginTop: 8 }}>{g.group}</Label>
          {g.tips.map((t) => <TipCard key={t.title} tip={t} />)}
        </View>
      ))}
      <Text style={st.small}>Personal savings are estimates from your trips and the app’s fuel model.</Text>
    </View>
  );
}

// ---------- welcome (first launch) ----------
const WELCOME_STEPS = [
  {
    title: 'What did that journey cost?',
    body: 'Miles & Pence works out the fuel cost of every trip as you drive. It uses your car, the way you drive and live UK pump prices.',
  },
  {
    title: 'How to use it',
    points: [
      'Put your phone in a mount with the app open.',
      'While driving, set Settings › Display & Brightness › Auto-Lock to Never. The app can’t track while the phone is locked.',
      'Tap Start a trip as you set off, and wait for the green dot.',
      'Stop at a fuel station and it asks how much you spent.',
      'Fill to full twice, entering your mileage, so it learns your car.',
    ],
  },
];

function WelcomeScreen({ onDone }) {
  const [i, setI] = useState(0);
  const s = WELCOME_STEPS[i];
  const last = i === WELCOME_STEPS.length - 1;
  return (
    <View style={[st.gap, { minHeight: 600 }]}>
      <Brand />
      <View style={{ flexDirection: 'row', gap: 6, marginTop: 24 }} accessibilityLabel={'Step ' + (i + 1) + ' of ' + WELCOME_STEPS.length}>
        {WELCOME_STEPS.map((_, k) => (
          <View key={k} style={{ height: 4, flex: 1, borderRadius: 2, backgroundColor: k <= i ? C.amber : C.line }} />
        ))}
      </View>
      <Text style={[st.h1, { fontSize: 32, marginTop: 16 }]}>{s.title}</Text>
      {s.body ? <Text style={[st.body, { fontSize: 17, lineHeight: 26 }]}>{s.body}</Text> : null}
      {s.points ? (
        <View style={{ gap: 14 }}>
          {s.points.map((p, k) => (
            <View key={k} style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
              <View style={st.stepNum}><Text style={st.stepNumText}>{k + 1}</Text></View>
              <Text style={[st.body, { flex: 1, color: C.ink, fontSize: 16 }]}>{p}</Text>
            </View>
          ))}
        </View>
      ) : null}
      <View style={{ flex: 1 }} />
      <Btn title="Next" onPress={() => (last ? onDone() : setI(i + 1))} />
      {i > 0 ? <Btn kind="quiet" title="Back" onPress={() => setI(i - 1)} /> : null}
    </View>
  );
}

// ---------- taking part in the test: agreement + privacy notice ----------
const contactLine = () => (CONTACT ? CONTACT : 'Jacob, the person who invited you to the test');

function Bullets({ items }) {
  return (
    <View style={{ gap: 8 }}>
      {items.map((t, k) => (
        <View key={k} style={{ flexDirection: 'row', gap: 10 }}>
          <Text style={[st.body, { color: C.amber }]}>•</Text>
          <Text style={[st.body, { flex: 1, color: C.ink }]}>{t}</Text>
        </View>
      ))}
    </View>
  );
}

function InsightsSwitch({ value, onChange }) {
  return (
    <View style={[st.switchRow, { alignItems: 'flex-start' }]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={st.switchText}>Optional: help build anonymous insights</Text>
        <Text style={st.small}>
          Let Miles & Pence keep and use your data after the test, anonymised and combined with other drivers’, for things like real-world mpg by car model. Off unless you turn it on; you can change it any time.
        </Text>
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: C.amber, false: C.line }} accessibilityLabel="Help build anonymous insights" />
    </View>
  );
}

function AgreeScreen({ onAgree, onPrivacy }) {
  const [insights, setInsights] = useState(false);
  return (
    <View style={st.gap}>
      <Brand />
      <Text style={[st.h1, { marginTop: 16 }]}>Taking part in the test</Text>
      <Text style={[st.body, { fontSize: 16 }]}>
        This test is about checking how accurate the app is. To do that, a summary of your trips and fill-ups is shared with Jacob, who runs the test.
      </Text>
      <View style={[st.card, { gap: 12 }]}>
        <Label>Shared automatically</Label>
        <Bullets items={['Your car’s make, model and fuel', 'Each trip’s date, miles, fuel used and cost', 'A driving score for each trip, with counts of sharp starts and stops', 'Your fill-ups: amount, litres, price and station']} />
        <Label style={{ marginTop: 6 }}>Never shared</Label>
        <Bullets items={['Your routes, or where trips start and finish', 'Your speeds', 'Your registration number or name']} />
      </View>
      <Bullets items={['You can leave the test at any time, which deletes your shared data.', 'You must be 18 or over to take part.']} />
      <Pressable accessibilityRole="link" onPress={onPrivacy} style={{ minHeight: 44, justifyContent: 'center' }}>
        <Text style={[st.body, { color: C.amber, fontWeight: '700', textDecorationLine: 'underline' }]}>Read the full privacy notice</Text>
      </Pressable>
      <View style={st.card}><InsightsSwitch value={insights} onChange={setInsights} /></View>
      <Btn title="I’m 18 or over and I agree" onPress={() => onAgree(insights)} />
    </View>
  );
}

function NoticeSection({ title, children }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={[st.h2, { fontSize: 17 }]}>{title}</Text>
      {children}
    </View>
  );
}

function PrivacyScreen({ data, fromAgree, share, onBack, onLeave, onSetInsights }) {
  const [armed, setArmed] = useState(false);
  const t = data.test || {};
  const taking = t.testerId && !t.left;
  return (
    <View style={st.gap}>
      <Brand />
      <Text style={st.h1}>Privacy notice</Text>
      <Text style={st.small}>Miles & Pence test · version {NOTICE_VERSION} · {NOTICE_DATE}</Text>
      <NoticeSection title="Who is responsible">
        <Text style={st.body}>Jacob runs the Miles & Pence test and is responsible for the data shared with it. Questions or requests go to {contactLine()}.</Text>
      </NoticeSection>
      <NoticeSection title="What is shared">
        <Bullets items={[
          'A random tester code, not your name',
          'Your car’s make, model, year, engine size and fuel, and the CO₂, mpg and fuel price you entered',
          'Each trip’s date, miles, time taken, estimated fuel and cost, and how much was town, A-road or motorway',
          'Each trip’s driving score (smooth driving and idling scores, and counts of sharp starts and stops)',
          'Your fill-ups: date, amount spent, litres, price, station name and any mileage you entered',
          'The app version and type of phone',
        ]} />
      </NoticeSection>
      <NoticeSection title="What is never shared">
        <Bullets items={[
          'Your routes, or where trips start and finish. GPS is used on your phone only, to measure distance and driving style.',
          'Your speeds, including any time above 70 mph. These are used on your phone only, for your own score and tips.',
          'Your registration number, name, contacts or trip names',
        ]} />
      </NoticeSection>
      <NoticeSection title="Why">
        <Text style={st.body}>To check how accurate the app is and improve it during the test. The legal basis is legitimate interests: the test exists to measure accuracy, and sharing this summary is a condition of taking part. Unless you opt in below, your data is not shared with other organisations, sold, used for advertising or used to contact you.</Text>
      </NoticeSection>
      <NoticeSection title="Optional: anonymous insights">
        <Text style={st.body}>Only if you turn this on, your data may be kept after the test and used, anonymised and combined with other drivers’, to produce insights such as real-world mpg by car model or the cost of driving in different areas. These insights may be published or shared with other organisations, and may be used commercially. They never identify you. The legal basis is your consent, and you can withdraw it at any time; your data then goes when the test data is deleted.</Text>
      </NoticeSection>
      <NoticeSection title="Who handles it">
        <Bullets items={[
          'Cloudflare stores the shared data, under its data protection terms. It may be processed outside the UK.',
          'GitHub hosts the app itself.',
          'AI tools such as Claude, made by Anthropic, may be used to analyse the results.',
        ]} />
      </NoticeSection>
      <NoticeSection title="How long it’s kept">
        <Text style={st.body}>The test runs until {TEST_END}. Shared data will be deleted by {DELETE_BY}, or straight away if you leave the test. If you opted in to anonymous insights, your data is anonymised and kept for that purpose until you withdraw.</Text>
      </NoticeSection>
      <NoticeSection title="Your rights">
        <Text style={st.body}>You can ask for a copy of your shared data, ask for it to be corrected, or have it deleted. Leaving the test deletes it immediately. If you’re unhappy with how it’s handled, you can complain to the Information Commissioner’s Office at ico.org.uk.</Text>
      </NoticeSection>
      <NoticeSection title="Who can take part">
        <Text style={st.body}>Adults aged 18 or over.</Text>
      </NoticeSection>
      <Text style={st.small}>Fuel prices contain public sector information licensed under the Open Government Licence v3.0 (UK Government Fuel Finder scheme).</Text>

      {!fromAgree && taking ? (
        <View style={[st.card, { gap: 10 }]}>
          <Label>Your test code: {t.testerId}</Label>
          <Text style={st.small}>Quote this code if you contact Jacob about your data.</Text>
          <InsightsSwitch value={!!t.insights} onChange={onSetInsights} />
          <Btn kind="quiet" title={armed ? 'Tap again to leave and delete my data' : 'Leave the test and delete my shared data'}
            onPress={() => { if (armed) onLeave(); else { setArmed(true); setTimeout(() => setArmed(false), 4000); } }}
            style={armed ? { borderColor: C.warn } : null} />
          <Text style={st.small}>Your trips stay on this phone and the app keeps working. Nothing more is shared.</Text>
        </View>
      ) : null}
      <Btn kind="quiet" title="Back" onPress={onBack} />
    </View>
  );
}

function ShareStatus({ data, share, go }) {
  const t = data.test || {};
  if (t.left) {
    return (
      <View style={st.card}>
        <Label>Test</Label>
        <Text style={st.small}>You left the test{t.leftAt ? ' on ' + new Date(t.leftAt).toLocaleDateString('en-GB') : ''}. Nothing is shared.</Text>
      </View>
    );
  }
  if (!t.testerId) return null;
  const line = share.state === 'ok' && share.at
    ? 'Last sent ' + ago(share.at) + '.'
    : share.state === 'sending' ? 'Sending…'
      : share.state === 'failed' ? 'Couldn’t send just now. It will try again next time something changes.'
        : 'Waiting for the test service to be switched on. Everything will be sent once it is.';
  return (
    <View style={st.card}>
      <View style={st.between}>
        <Label>Sharing with the test team</Label>
        <Text style={[st.small, { color: share.state === 'ok' ? C.good : share.state === 'failed' ? C.warn : C.muted }]}>{t.testerId}</Text>
      </View>
      <Text style={st.small}>{line}</Text>
      <Pressable accessibilityRole="link" onPress={() => go('privacy')} style={{ minHeight: 44, justifyContent: 'center' }}>
        <Text style={[st.small, { color: C.amber, fontWeight: '700', textDecorationLine: 'underline' }]}>Privacy notice and leaving the test</Text>
      </Pressable>
    </View>
  );
}

// ---------- feedback ----------
const FEEDBACK_TOPICS = ['Something broke', 'A cost looked wrong', 'Missed a trip or fuel stop', 'An idea', 'Something else'];

function FeedbackScreen({ data, cal, price, say, onDone }) {
  const [topic, setTopic] = useState(null);
  const [text, setText] = useState('');
  const [withSummary, setWithSummary] = useState(true);

  const summary = () => {
    const c = data.car || {};
    const mon = todayKey().slice(0, 7);
    const s = monthSummary(data.car, data.entries, mon);
    const trips = sortEntries(data.entries).filter((e) => e.kind === 'trip');
    const fills = data.entries.filter((e) => e.kind === 'fill');
    const lastTrips = trips.slice(-3).reverse().map((t) => {
      const f = tripFuel(t, data.car, data.entries, cal, price);
      return '  ' + t.date + ': ' + t.miles + ' mi, ' + (f.cost != null ? gbp(f.cost) : '?') + (t.source === 'gps' ? '' : ' (by hand)') + (t.gapMiles ? ', ' + t.gapMiles + ' mi estimated' : '');
    });
    return [
      '— Details —',
      'App: Miles & Pence ' + APP_VERSION + (Platform.OS === 'web' && typeof navigator !== 'undefined' ? ' · ' + (/iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : 'other') : ''),
      'Car: ' + ([c.make, c.model].filter(Boolean).join(' ') || 'not looked up') + ', ' + (c.fuel || '?') + ', official ' + (officialMpg(c) ? officialMpg(c).toFixed(1) : '?') + ' mpg' + (cal.realMpg ? ', real ' + cal.realMpg.toFixed(1) + ' mpg' : ''),
      'Logged: ' + trips.length + ' trips, ' + fills.length + ' fill-ups',
      'This month: ' + Math.round(s.miles) + ' mi, trips ' + gbp(s.est) + ', fuel bought ' + gbp(s.bought),
      ...(lastTrips.length ? ['Last trips:', ...lastTrips] : []),
    ].join('\n');
  };

  const send = async () => {
    const message = ['Miles & Pence feedback' + (topic ? ': ' + topic : ''), '', text.trim(), '', withSummary ? summary() : ''].join('\n').trim();
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ title: 'Miles & Pence feedback', text: message });
      } else if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(message);
        say('Copied. Paste it into a message to send.');
      } else {
        await Share.share({ message });
      }
      onDone();
    } catch (e) {
      if (!(e && e.name === 'AbortError')) say("Couldn't open sharing");
    }
  };

  return (
    <View style={st.gap}>
      <Brand reg={data.car && data.car.reg} />
      <Text style={st.h1}>Send feedback</Text>
      <Text style={st.body}>What happened, or what would make it better? It opens your phone’s share sheet, so you can send it by message or email to whoever invited you to test.</Text>
      <View style={st.chips}>
        {FEEDBACK_TOPICS.map((t) => (
          <Pressable key={t} accessibilityRole="button" accessibilityState={{ selected: topic === t }} onPress={() => setTopic(topic === t ? null : t)}
            style={[st.topicChip, topic === t && st.chipOn]}>
            <Text style={[st.btnTextQuiet, { fontSize: 14 }, topic === t && { color: C.onAmber }]}>{t}</Text>
          </Pressable>
        ))}
      </View>
      <View style={st.field}>
        <Text style={st.fieldLabel}>Tell us more</Text>
        <TextInput value={text} onChangeText={setText} multiline placeholder="e.g. The trip to work said 12.1 miles but the car said 13.4" placeholderTextColor="#6F827B"
          accessibilityLabel="Tell us more" style={[st.input, { height: 140, paddingTop: 12, textAlignVertical: 'top' }]} />
      </View>
      <View style={st.switchRow}>
        <View style={{ flex: 1 }}>
          <Text style={st.switchText}>Include a trip summary</Text>
          <Text style={st.small}>Your car, totals and last 3 trips. No locations.</Text>
        </View>
        <Switch value={withSummary} onValueChange={setWithSummary} trackColor={{ true: C.amber, false: C.line }} accessibilityLabel="Include a trip summary" />
      </View>
      <Btn title="Send feedback" onPress={send} disabled={!topic && !text.trim()} />
      <Btn kind="quiet" title="Cancel" onPress={onDone} />
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
  barTrack: { height: 8, borderRadius: 4, backgroundColor: C.sunk, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4 },
  scoreRing: { width: 84, height: 84, borderRadius: 42, borderWidth: 5, alignItems: 'center', justifyContent: 'center' },
  topicChip: { minHeight: 44, paddingHorizontal: 14, borderRadius: 22, borderWidth: 1, borderColor: C.line, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center' },
  stepNum: { width: 28, height: 28, borderRadius: 14, backgroundColor: C.amber, alignItems: 'center', justifyContent: 'center', marginTop: -2 },
  stepNumText: { color: C.onAmber, fontWeight: '800', fontFamily: SANS },
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
