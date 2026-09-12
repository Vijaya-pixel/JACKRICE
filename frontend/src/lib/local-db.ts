import type {
  ClinicalContext,
  CreatePatientInput,
  CreateSessionInput,
  Interaction,
  Patient,
  SaveClinicalContextInput,
  SaveInteractionInput,
  SaveVitalReadingInput,
  Session,
  UpdatePatientInput,
  VitalReading,
} from "@/types/tacit";

const DB_NAME = "tacit-local";
const DB_VERSION = 1;

type StoreName = "patients" | "clinicalContexts" | "sessions" | "interactions" | "vitalReadings";

function timestamp() {
  return new Date().toISOString();
}

function uuid() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function electronDb() {
  return typeof window !== "undefined" ? window.tacit : undefined;
}

function openIndexedDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this environment"));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains("patients")) {
        const store = db.createObjectStore("patients", { keyPath: "id" });
        store.createIndex("patientId", "patientId", { unique: true });
      }
      if (!db.objectStoreNames.contains("clinicalContexts")) {
        const store = db.createObjectStore("clinicalContexts", { keyPath: "id" });
        store.createIndex("patientId", "patientId", { unique: true });
      }
      if (!db.objectStoreNames.contains("sessions")) {
        const store = db.createObjectStore("sessions", { keyPath: "id" });
        store.createIndex("patientId", "patientId", { unique: false });
      }
      if (!db.objectStoreNames.contains("interactions")) {
        const store = db.createObjectStore("interactions", { keyPath: "id" });
        store.createIndex("sessionId", "sessionId", { unique: false });
        store.createIndex("patientId", "patientId", { unique: false });
      }
      if (!db.objectStoreNames.contains("vitalReadings")) {
        const store = db.createObjectStore("vitalReadings", { keyPath: "id" });
        store.createIndex("sessionId", "sessionId", { unique: false });
      }
    };
  });
}

async function withStore<T>(
  storeName: StoreName,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openIndexedDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = run(tx.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function getAll<T>(storeName: StoreName): Promise<T[]> {
  return withStore<T[]>(storeName, "readonly", (store) => store.getAll() as IDBRequest<T[]>);
}

async function getByIndex<T>(storeName: StoreName, indexName: string, value: string): Promise<T | null> {
  const result = await withStore<T | undefined>(
    storeName,
    "readonly",
    (store) => store.index(indexName).get(value) as IDBRequest<T | undefined>,
  );
  return result ?? null;
}

async function put<T extends { id: string }>(storeName: StoreName, value: T): Promise<T> {
  await withStore<IDBValidKey>(storeName, "readwrite", (store) => store.put(value));
  return value;
}

async function remove(storeName: StoreName, id: string): Promise<boolean> {
  await withStore<undefined>(storeName, "readwrite", (store) => store.delete(id));
  return true;
}

async function indexedCreatePatient(input: CreatePatientInput): Promise<Patient | null> {
  const patientId = input.patientId.trim();
  const name = input.name.trim();
  if (!patientId || !name) return null;
  const existing = await indexedGetPatientByPatientId(patientId);
  if (existing) return indexedUpdatePatient(existing.id, { name });
  const stamp = timestamp();
  return put("patients", { id: uuid(), patientId, name, createdAt: stamp, updatedAt: stamp });
}

async function indexedUpdatePatient(id: string, updates: UpdatePatientInput): Promise<Patient | null> {
  const existing = await withStore<Patient | undefined>(
    "patients",
    "readonly",
    (store) => store.get(id) as IDBRequest<Patient | undefined>,
  );
  if (!existing) return null;
  const next: Patient = {
    ...existing,
    patientId: updates.patientId?.trim() || existing.patientId,
    name: updates.name?.trim() || existing.name,
    updatedAt: timestamp(),
  };
  return put("patients", next);
}

async function indexedGetPatientByPatientId(patientId: string): Promise<Patient | null> {
  return getByIndex<Patient>("patients", "patientId", patientId.trim());
}

async function indexedSaveClinicalContext(input: SaveClinicalContextInput): Promise<ClinicalContext | null> {
  const existing = await getByIndex<ClinicalContext>("clinicalContexts", "patientId", input.patientId);
  const stamp = timestamp();
  const context: ClinicalContext = {
    id: existing?.id || uuid(),
    patientId: input.patientId,
    diagnosis: input.diagnosis || "",
    procedure: input.procedure || "",
    medicalNotes: input.medicalNotes || "",
    bloodTestNotes: input.bloodTestNotes || "",
    additionalContext: input.additionalContext || "",
    createdAt: existing?.createdAt || stamp,
    updatedAt: stamp,
  };
  return put("clinicalContexts", context);
}

async function indexedCreateSession(input: CreateSessionInput): Promise<Session | null> {
  if (!input.patientId) return null;
  return put("sessions", {
    id: uuid(),
    patientId: input.patientId,
    startedAt: input.startedAt || timestamp(),
    endedAt: null,
    status: "active" as const,
  });
}

async function indexedCompleteSession(id: string, endedAt = timestamp()): Promise<Session | null> {
  const existing = await withStore<Session | undefined>(
    "sessions",
    "readonly",
    (store) => store.get(id) as IDBRequest<Session | undefined>,
  );
  if (!existing) return null;
  return put("sessions", { ...existing, endedAt, status: "completed" as const });
}

async function indexedSaveInteraction(input: SaveInteractionInput): Promise<Interaction | null> {
  if (!input.sessionId || !input.patientId) return null;
  return put("interactions", {
    id: uuid(),
    sessionId: input.sessionId,
    patientId: input.patientId,
    question: input.question || "",
    questionType: input.questionType,
    response: input.response || "",
    timestamp: input.timestamp || timestamp(),
  });
}

async function indexedSaveVitalReading(input: SaveVitalReadingInput): Promise<VitalReading | null> {
  if (!input.sessionId || !input.type) return null;
  return put("vitalReadings", {
    id: uuid(),
    sessionId: input.sessionId,
    type: input.type,
    value: String(input.value),
    unit: input.unit || "",
    timestamp: input.timestamp || timestamp(),
  });
}

async function listByIndex<T>(storeName: StoreName, indexName: string, value: string): Promise<T[]> {
  const db = await openIndexedDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).index(indexName).getAll(value) as IDBRequest<T[]>;
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export const localDb = {
  async listPatients(): Promise<Patient[]> {
    return electronDb()?.dbListPatients?.() ?? getAll<Patient>("patients");
  },

  async createPatient(input: CreatePatientInput): Promise<Patient | null> {
    return electronDb()?.dbCreatePatient?.(input) ?? indexedCreatePatient(input);
  },

  async getPatient(id: string): Promise<Patient | null> {
    return electronDb()?.dbGetPatient?.(id) ?? withStore<Patient | undefined>(
      "patients",
      "readonly",
      (store) => store.get(id) as IDBRequest<Patient | undefined>,
    ).then((patient) => patient ?? null);
  },

  async getPatientByPatientId(patientId: string): Promise<Patient | null> {
    return electronDb()?.dbGetPatientByPatientId?.(patientId) ?? indexedGetPatientByPatientId(patientId);
  },

  async updatePatient(id: string, updates: UpdatePatientInput): Promise<Patient | null> {
    return electronDb()?.dbUpdatePatient?.(id, updates) ?? indexedUpdatePatient(id, updates);
  },

  async deletePatient(id: string): Promise<boolean> {
    return electronDb()?.dbDeletePatient?.(id) ?? remove("patients", id);
  },

  async getClinicalContext(patientId: string): Promise<ClinicalContext | null> {
    return electronDb()?.dbGetClinicalContext?.(patientId) ?? getByIndex<ClinicalContext>("clinicalContexts", "patientId", patientId);
  },

  async saveClinicalContext(input: SaveClinicalContextInput): Promise<ClinicalContext | null> {
    return electronDb()?.dbSaveClinicalContext?.(input) ?? indexedSaveClinicalContext(input);
  },

  async createSession(input: CreateSessionInput): Promise<Session | null> {
    return electronDb()?.dbCreateSession?.(input) ?? indexedCreateSession(input);
  },

  async getSession(id: string): Promise<Session | null> {
    return electronDb()?.dbGetSession?.(id) ?? withStore<Session | undefined>(
      "sessions",
      "readonly",
      (store) => store.get(id) as IDBRequest<Session | undefined>,
    ).then((session) => session ?? null);
  },

  async completeSession(id: string, endedAt?: string): Promise<Session | null> {
    return electronDb()?.dbCompleteSession?.(id, endedAt) ?? indexedCompleteSession(id, endedAt);
  },

  async saveInteraction(input: SaveInteractionInput): Promise<Interaction | null> {
    return electronDb()?.dbSaveInteraction?.(input) ?? indexedSaveInteraction(input);
  },

  async listInteractionsForSession(sessionId: string): Promise<Interaction[]> {
    return electronDb()?.dbListInteractionsForSession?.(sessionId) ?? listByIndex<Interaction>("interactions", "sessionId", sessionId);
  },

  async saveVitalReading(input: SaveVitalReadingInput): Promise<VitalReading | null> {
    return electronDb()?.dbSaveVitalReading?.(input) ?? indexedSaveVitalReading(input);
  },

  async listVitalReadingsForSession(sessionId: string): Promise<VitalReading[]> {
    return electronDb()?.dbListVitalReadingsForSession?.(sessionId) ?? listByIndex<VitalReading>("vitalReadings", "sessionId", sessionId);
  },
};
