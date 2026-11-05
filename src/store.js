import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'milesandpence:v1';
const EMPTY = { car: null, entries: [], spots: [] };

export async function loadData() {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const d = JSON.parse(raw);
    return { car: d.car || null, entries: d.entries || [], spots: d.spots || [] };
  } catch (e) {
    return EMPTY;
  }
}

export async function saveData(data) {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch (e) {
    return false;
  }
}

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
