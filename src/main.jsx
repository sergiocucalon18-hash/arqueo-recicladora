import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { signInAnonymously } from 'firebase/auth';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { auth, db } from './firebase';
import './styles.css';

const DATA_REF = doc(db, 'arqueos', 'almetales');
const SESSION_KEY = 'arqueo-recicladora-session';
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const denominations = [100, 50, 20, 10, 5, 1, 0.25, 0.1, 0.05, 0.01];
const defaultData = { ownerPin: '1234', employeePin: 'empleado', shifts: [], updatedAt: '' };

function App() {
  const [data, setData] = useState(defaultData);
  const [loading, setLoading] = useState(true);
  const [syncError, setSyncError] = useState('');
  const [session, setSession] = useState(() => readSession());
  const [activeView, setActiveView] = useState(session?.role === 'owner' ? 'owner' : 'employee');
  const [activeDate, setActiveDate] = useState(today());
  const [deleteUnlocked, setDeleteUnlocked] = useState(false);
  const [shiftModal, setShiftModal] = useState(null);
  const [movementModal, setMovementModal] = useState(null);

  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;

    async function start() {
      try {
        await signInAnonymously(auth);
      } catch (error) {
        setSyncError(`Autenticacion Firebase: ${error.message}`);
      }

      if (cancelled) return;
      unsubscribe = onSnapshot(
        DATA_REF,
        async (snapshot) => {
          if (!snapshot.exists()) {
            await setDoc(DATA_REF, defaultData);
            setData(defaultData);
          } else {
            setData(normalizeData(snapshot.data()));
          }
          setLoading(false);
          setSyncError('');
        },
        (error) => {
          setLoading(false);
          setSyncError(error.message);
        }
      );
    }

    start();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const ownerUnlocked = session?.role === 'owner';
  const dayItems = useMemo(() => dayShifts(data.shifts, activeDate), [data.shifts, activeDate]);
  const pageCopy = {
    employee: ['Registrar caja del turno', 'Registra ingresos, gastos y cierre de efectivo del turno.'],
    owner: ['Revision privada del dueno', 'Cuadres, diferencias, reportes y edicion completa.'],
    settings: ['Configuracion', 'Claves, respaldo, importacion y limpieza de datos.']
  };

  async function persist(nextData) {
    const payload = normalizeData({ ...nextData, updatedAt: new Date().toISOString() });
    await setDoc(DATA_REF, payload);
  }

  function login(role, name, password) {
    const cleanName = name.trim() || (role === 'owner' ? 'Dueno' : 'Empleado');
    if (role === 'owner' && password !== data.ownerPin) {
      alert('PIN de dueno incorrecto.');
      return;
    }
    if (role === 'employee' && password !== data.employeePin) {
      alert('Clave de empleado incorrecta.');
      return;
    }
    const next = { role, name: cleanName };
    localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    setSession(next);
    setActiveView(role === 'owner' ? 'owner' : 'employee');
  }

  function logout() {
    localStorage.removeItem(SESSION_KEY);
    setSession(null);
    setDeleteUnlocked(false);
    setActiveView('employee');
  }

  async function saveShift(form) {
    const existing = form.id
      ? data.shifts.find((entry) => entry.id === form.id)
      : findShift(data.shifts, form.date, form.shiftName);
    const id = existing?.id || uid();
    const shift = {
      id,
      date: form.date,
      shiftName: form.shiftName,
      employeeName: form.employeeName.trim(),
      openingCash: ownerUnlocked ? num(form.openingCash) : autoOpeningCash(data.shifts, form.date, form.shiftName),
      purchaseTotal: num(form.purchaseTotal),
      status: form.status,
      notes: form.notes.trim(),
      denoms: form.denoms,
      movements: existing?.movements || [],
      savedAt: new Date().toISOString()
    };
    await persist({ ...data, shifts: upsert(data.shifts, shift) });
    setShiftModal(null);
    alert('Cierre guardado.');
  }

  async function saveMovement(form) {
    const movement = {
      id: form.id || uid(),
      type: form.type,
      amount: num(form.amount),
      reason: form.reason.trim(),
      employeeName: form.employeeName.trim(),
      savedAt: new Date().toISOString()
    };
    const cleaned = data.shifts.map((shift) => ({
      ...shift,
      movements: (shift.movements || []).filter((entry) => entry.id !== movement.id)
    }));
    const nextShifts = addMovementToShift(cleaned, form.date, form.shiftName, movement);
    await persist({ ...data, shifts: nextShifts });
    setMovementModal(null);
    alert('Movimiento guardado.');
  }

  async function deleteShift(id) {
    if (!ownerUnlocked || !confirm('Eliminar este cierre de turno?')) return;
    await persist({ ...data, shifts: data.shifts.filter((item) => item.id !== id) });
  }

  async function deleteMovement(shiftId, movementId) {
    if (!ownerUnlocked && !deleteUnlocked) return;
    if (!confirm('Eliminar este movimiento?')) return;
    const shifts = data.shifts.map((shift) => {
      if (shift.id !== shiftId) return shift;
      return { ...shift, movements: (shift.movements || []).filter((item) => item.id !== movementId) };
    });
    await persist({ ...data, shifts });
  }

  async function saveConfig(ownerPin, employeePin) {
    if (!ownerUnlocked) return;
    if (ownerPin.trim().length < 4 || employeePin.trim().length < 4) {
      alert('Usa claves de minimo 4 caracteres.');
      return;
    }
    await persist({ ...data, ownerPin: ownerPin.trim(), employeePin: employeePin.trim() });
    logout();
    alert('Claves actualizadas. Ingresa de nuevo.');
  }

  async function importData(file) {
    if (!file || !ownerUnlocked) return;
    const text = await file.text();
    try {
      const imported = normalizeData(JSON.parse(text));
      await persist(imported);
      alert('Datos importados.');
    } catch {
      alert('El archivo no parece ser JSON valido.');
    }
  }

  async function clearData() {
    if (!ownerUnlocked || !confirm('Esto borrara todos los cierres guardados. Continuar?')) return;
    await persist(defaultData);
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `arqueo-recicladora-${activeDate}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function unlockEmployeeDelete() {
    const pin = prompt('Clave del dueno para permitir eliminar ingresos o gastos:');
    if (pin !== data.ownerPin) {
      alert('Clave incorrecta.');
      return;
    }
    setDeleteUnlocked(true);
  }

  if (!session) return <Login data={data} loading={loading} syncError={syncError} onLogin={login} />;

  return (
    <div className="app">
      <aside>
        <div className="brand">
          <div className="brand-mark">$</div>
          <div>
            <h1>Arqueo Recicladora</h1>
            <span>Turno dia y turno noche</span>
          </div>
        </div>

        <nav className="nav" aria-label="Navegacion principal">
          <button className={activeView === 'employee' ? 'active' : ''} onClick={() => setActiveView('employee')}>Registrar turno</button>
          {ownerUnlocked && <button className={activeView === 'owner' ? 'active' : ''} onClick={() => setActiveView('owner')}>Revision dueno</button>}
          {ownerUnlocked && <button className={activeView === 'settings' ? 'active' : ''} onClick={() => setActiveView('settings')}>Configuracion</button>}
        </nav>

        <div className="session-box">
          <small>Sesion activa</small>
          <strong>{session.name}</strong>
          <span>{ownerUnlocked ? 'Dueno' : 'Empleado'}</span>
          <button className="secondary dark" onClick={logout}>Salir</button>
        </div>
      </aside>

      <main>
        <div className="topbar">
          <div className="title">
            <h2>{pageCopy[activeView][0]}</h2>
            <p>{pageCopy[activeView][1]}</p>
            <SyncStatus loading={loading} error={syncError} updatedAt={data.updatedAt} />
          </div>
          <div className="toolbar">
            <input type="date" value={activeDate} onChange={(event) => setActiveDate(event.target.value)} aria-label="Fecha activa" />
            <button className="secondary" onClick={() => window.print()}>Imprimir</button>
            {ownerUnlocked && <button className="primary" onClick={exportData}>Exportar respaldo</button>}
          </div>
        </div>

        {activeView === 'employee' && (
          <EmployeeView
            shifts={dayItems}
            deleteUnlocked={deleteUnlocked}
            onOpenShift={() => setShiftModal(openShiftForm(data.shifts, activeDate, null, ownerUnlocked, session.name))}
            onOpenMovement={(type) => setMovementModal(openMovementForm(data.shifts, activeDate, null, type, session.name))}
            onDeleteMovement={deleteMovement}
            onUnlockDelete={unlockEmployeeDelete}
            onLockDelete={() => setDeleteUnlocked(false)}
          />
        )}

        {activeView === 'owner' && ownerUnlocked && (
          <OwnerView
            shifts={dayItems}
            onOpenShift={(id) => setShiftModal(openShiftForm(data.shifts, activeDate, id, ownerUnlocked, session.name))}
            onOpenMovement={(id) => setMovementModal(openMovementForm(data.shifts, activeDate, id, 'gasto', session.name))}
            onDeleteShift={deleteShift}
            onDeleteMovement={deleteMovement}
          />
        )}

        {activeView === 'settings' && ownerUnlocked && (
          <SettingsView data={data} onSave={saveConfig} onImport={importData} onClear={clearData} />
        )}
      </main>

      {shiftModal && (
        <ShiftModal
          form={shiftModal}
          ownerUnlocked={ownerUnlocked}
          shifts={data.shifts}
          onClose={() => setShiftModal(null)}
          onChange={setShiftModal}
          onSubmit={saveShift}
        />
      )}
      {movementModal && (
        <MovementModal
          form={movementModal}
          onClose={() => setMovementModal(null)}
          onChange={setMovementModal}
          onSubmit={saveMovement}
        />
      )}
    </div>
  );
}

function Login({ data, loading, syncError, onLogin }) {
  const [role, setRole] = useState('employee');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');

  function submit(event) {
    event.preventDefault();
    onLogin(role, name, password);
  }

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="brand login-brand">
          <div className="brand-mark">$</div>
          <div>
            <h1>Arqueo Recicladora</h1>
            <span>Sincronizado con Firestore</span>
          </div>
        </div>
        <div className="segmented">
          <button type="button" className={role === 'employee' ? 'active' : ''} onClick={() => setRole('employee')}>Empleado</button>
          <button type="button" className={role === 'owner' ? 'active' : ''} onClick={() => setRole('owner')}>Dueno</button>
        </div>
        <label>Nombre
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder={role === 'owner' ? 'Dueno' : 'Nombre del empleado'} />
        </label>
        <label>{role === 'owner' ? 'PIN del dueno' : 'Clave de empleado'}
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={role === 'owner' ? 'PIN' : 'Clave'} required />
        </label>
        <button className="primary" disabled={loading}>{loading ? 'Conectando...' : 'Entrar'}</button>
        {syncError && <p className="error">Firestore no respondio: {syncError}</p>}
        <p className="hint">Accesos iniciales: dueno usa <b>1234</b> y empleado usa <b>empleado</b>. Cambialos en configuracion.</p>
      </form>
    </main>
  );
}

function EmployeeView({ shifts, deleteUnlocked, onOpenShift, onOpenMovement, onDeleteMovement, onUnlockDelete, onLockDelete }) {
  const movements = shifts.flatMap((shift) => (shift.movements || []).map((movement) => ({ ...movement, shiftName: shift.shiftName, shiftId: shift.id })));
  const incomes = movements.filter((movement) => movement.type === 'ingreso');
  const expenses = movements.filter((movement) => movement.type === 'gasto' || movement.type === 'retiro');
  const incomeTotal = incomes.reduce((sum, movement) => sum + cents(movement.amount), 0);
  const expenseTotal = expenses.reduce((sum, movement) => sum + cents(movement.amount), 0);

  return (
    <section className="grid">
      <div className="panel span-12 intro-panel">
        <div className="section-title">
          <h3>Turno en curso</h3>
          <button className="primary" onClick={onOpenShift}>Cerrar turno</button>
        </div>
        <p>Registra cada ingreso o gasto cuando ocurre. Al final cuenta el efectivo que dejas para el siguiente turno.</p>
      </div>
      <MovementBox title="Ingresos registrados" total={incomeTotal} status="ok" movements={incomes} emptyText="No hay ingresos registrados para esta fecha." canDelete={deleteUnlocked} onAdd={() => onOpenMovement('ingreso')} onDelete={onDeleteMovement} />
      <MovementBox title="Gastos registrados" total={expenseTotal} status="bad" movements={expenses} emptyText="No hay gastos registrados para esta fecha." canDelete={deleteUnlocked} onAdd={() => onOpenMovement('gasto')} onDelete={onDeleteMovement} />
      <div className="panel span-12">
        <div className="section-title"><h3>Operacion del turno</h3></div>
        <table>
          <tbody>
            <tr><td>Turnos</td><td>Dia / Noche</td></tr>
            <tr><td>Moneda</td><td>Dolares</td></tr>
            <tr><td>Material</td><td>Se toma del reporte del sistema de pesaje</td></tr>
          </tbody>
        </table>
        <div className="toolbar lower">
          {!deleteUnlocked && <button className="secondary" onClick={onUnlockDelete}>Eliminar con clave</button>}
          {deleteUnlocked && <button className="secondary" onClick={onLockDelete}>Bloquear eliminacion</button>}
          {deleteUnlocked && <span className="status warn">Eliminacion activa</span>}
        </div>
      </div>
    </section>
  );
}

function MovementBox({ title, total, status, movements, emptyText, canDelete, onAdd, onDelete }) {
  return (
    <div className="panel span-6">
      <div className="section-title">
        <h3>{title}</h3>
        <div className="toolbar">
          <span className={`status ${status}`}>{money.format(fromCents(total))}</span>
          <button className="primary" onClick={onAdd}>Registrar</button>
        </div>
      </div>
      {!movements.length ? <Empty text={emptyText} /> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Turno</th><th>Motivo</th><th>Monto</th><th>Empleado</th>{canDelete && <th>Accion</th>}</tr>
            </thead>
            <tbody>
              {movements.map((movement) => (
                <tr key={movement.id}>
                  <td>{movement.shiftName}</td>
                  <td>{movement.type === 'retiro' && <span className="status warn mini">retiro</span>} {movement.reason}</td>
                  <td>{money.format(num(movement.amount))}</td>
                  <td>{movement.employeeName || '-'}</td>
                  {canDelete && <td><button className="icon-btn" title="Eliminar" onClick={() => onDelete(movement.shiftId, movement.id)}>x</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function OwnerView({ shifts, onOpenShift, onOpenMovement, onDeleteShift, onDeleteMovement }) {
  const purchases = shifts.reduce((sum, shift) => sum + cents(shift.purchaseTotal), 0);
  const expenses = shifts.reduce((sum, shift) => sum + movementTotals(shift).gasto + movementTotals(shift).retiro, 0);
  const left = shifts.reduce((sum, shift) => sum + cashLeft(shift.denoms), 0);
  const diff = shifts.reduce((sum, shift) => sum + shiftDiff(shift), 0);

  return (
    <section className="grid">
      <Metric title="Compras reportadas" value={money.format(fromCents(purchases))} note="Sistema de pesaje" />
      <Metric title="Gastos y retiros" value={money.format(fromCents(expenses))} note="Registrados por turno" />
      <Metric title="Efectivo dejado" value={money.format(fromCents(left))} note="Contado por denominaciones" />
      <Metric title="Diferencia neta" value={money.format(fromCents(diff))} note={shifts.length ? diffText(diff) : 'Sin cierres'} />
      <div className="panel span-12 private">
        <div className="section-title">
          <h3>Cuadre de turnos</h3>
          <div className="toolbar no-print">
            <button className="secondary" onClick={() => onOpenMovement(null)}>Agregar movimiento</button>
            <button className="secondary" onClick={() => onOpenShift(null)}>Agregar cierre</button>
          </div>
        </div>
        {!shifts.length ? <Empty text="No hay cierres para revisar en esta fecha." /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Turno</th><th>Empleado</th><th>Ingresos</th><th>Gastos</th><th>Retiros</th><th>Compras</th><th>Esperado</th><th>Dejado</th><th>Diferencia</th><th>Accion</th></tr>
              </thead>
              <tbody>
                {shifts.map((shift) => <OwnerShiftRows key={shift.id} shift={shift} onOpenShift={onOpenShift} onOpenMovement={onOpenMovement} onDeleteShift={onDeleteShift} onDeleteMovement={onDeleteMovement} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function OwnerShiftRows({ shift, onOpenShift, onOpenMovement, onDeleteShift, onDeleteMovement }) {
  const totals = movementTotals(shift);
  const expected = expectedLeft(shift);
  const left = cashLeft(shift.denoms);
  const diff = shiftDiff(shift);
  return (
    <>
      <tr>
        <td>{shift.shiftName}</td>
        <td>{shift.employeeName || '-'}</td>
        <td>{money.format(fromCents(totals.ingreso))}</td>
        <td>{money.format(fromCents(totals.gasto))}</td>
        <td>{money.format(fromCents(totals.retiro))}</td>
        <td>{money.format(num(shift.purchaseTotal))}</td>
        <td>{money.format(fromCents(expected))}</td>
        <td>{money.format(fromCents(left))}</td>
        <td><span className={`status ${diffClass(diff)}`}>{diffText(diff)} {money.format(Math.abs(fromCents(diff)))}</span></td>
        <td><RowActions onEdit={() => onOpenShift(shift.id)} onDelete={() => onDeleteShift(shift.id)} /></td>
      </tr>
      {(shift.movements || []).length === 0 && <tr><td colSpan="10" className="muted">Sin movimientos registrados durante el turno.</td></tr>}
      {(shift.movements || []).map((movement) => (
        <tr key={movement.id} className="subrow">
          <td colSpan="3">{timeText(movement.savedAt)}</td>
          <td colSpan="4"><span className={`status mini ${movement.type === 'ingreso' ? 'ok' : movement.type === 'retiro' ? 'warn' : 'bad'}`}>{movement.type}</span> {movement.reason}</td>
          <td>{money.format(num(movement.amount))}</td>
          <td>{movement.employeeName || '-'}</td>
          <td><RowActions onEdit={() => onOpenMovement(movement.id)} onDelete={() => onDeleteMovement(shift.id, movement.id)} /></td>
        </tr>
      ))}
      {shift.notes && <tr><td colSpan="10" className="muted">Notas: {shift.notes}</td></tr>}
    </>
  );
}

function SettingsView({ data, onSave, onImport, onClear }) {
  const [ownerPin, setOwnerPin] = useState(data.ownerPin);
  const [employeePin, setEmployeePin] = useState(data.employeePin);
  return (
    <section className="grid">
      <div className="panel span-6">
        <div className="section-title"><h3>Accesos</h3></div>
        <form className="form-grid" onSubmit={(event) => { event.preventDefault(); onSave(ownerPin, employeePin); }}>
          <label className="span-field-6">PIN del dueno
            <input type="password" value={ownerPin} onChange={(event) => setOwnerPin(event.target.value)} />
          </label>
          <label className="span-field-6">Clave de empleado
            <input type="password" value={employeePin} onChange={(event) => setEmployeePin(event.target.value)} />
          </label>
          <button className="primary span-field-12">Guardar claves</button>
        </form>
      </div>
      <div className="panel span-6">
        <div className="section-title"><h3>Datos</h3></div>
        <p className="muted">Los datos se guardan en Firestore y se sincronizan en tiempo real entre equipos.</p>
        <div className="toolbar">
          <label className="secondary file-button">Importar JSON<input type="file" accept="application/json" onChange={(event) => onImport(event.target.files[0])} /></label>
          <button className="danger" onClick={onClear}>Limpiar todo</button>
        </div>
        <p className="hint">Registros guardados: {data.shifts.length}</p>
      </div>
    </section>
  );
}

function ShiftModal({ form, ownerUnlocked, shifts, onClose, onChange, onSubmit }) {
  const automatic = autoOpeningCash(shifts, form.date, form.shiftName);
  const denomTotal = money.format(fromCents(cashLeft(form.denoms)));

  useEffect(() => {
    if (!ownerUnlocked || !form.id) onChange({ ...form, openingCash: automatic });
  }, [form.date, form.shiftName]);

  function setField(field, value) {
    onChange({ ...form, [field]: value });
  }

  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={(event) => { event.preventDefault(); onSubmit(form); }}>
        <div className="modal-head">
          <h3>Cierre de turno</h3>
          <button type="button" className="icon-btn" onClick={onClose}>x</button>
        </div>
        <div className="form-grid">
          <label className="span-field-3">Fecha<input type="date" value={form.date} onChange={(event) => setField('date', event.target.value)} required /></label>
          <label className="span-field-3">Turno<select value={form.shiftName} onChange={(event) => setField('shiftName', event.target.value)} required><option>Turno dia</option><option>Turno noche</option></select></label>
          <label className="span-field-3">Empleado<input value={form.employeeName} onChange={(event) => setField('employeeName', event.target.value)} placeholder="Nombre" /></label>
          <label className="span-field-3">Saldo inicial recibido<input type="number" min="0" step="0.01" value={form.openingCash} readOnly={!ownerUnlocked} onChange={(event) => setField('openingCash', event.target.value)} /><small>{ownerUnlocked ? `Puedes corregirlo. Automatico sugerido: ${money.format(automatic)}.` : `Viene del efectivo dejado por el turno anterior: ${money.format(automatic)}.`}</small></label>
          <label className="span-field-4">Total compras reciclaje<input type="number" min="0" step="0.01" value={form.purchaseTotal} onChange={(event) => setField('purchaseTotal', event.target.value)} required /></label>
          <label className="span-field-4">Estado del turno<select value={form.status} onChange={(event) => setField('status', event.target.value)}><option value="abierto">Abierto</option><option value="cerrado">Cerrado</option></select></label>
          <label className="span-field-4">Notas del cierre<input value={form.notes} onChange={(event) => setField('notes', event.target.value)} placeholder="Observacion final" /></label>
        </div>
        <div className="section-title denom-title">
          <h3>Efectivo que deja para el siguiente turno</h3>
          <span className="status info">{denomTotal}</span>
        </div>
        <div className="denoms">
          {denominations.map((denom) => (
            <label className="denom" key={denom}><b>{money.format(denom)}</b>
              <input type="number" min="0" step="1" value={form.denoms[denom] ?? 0} onChange={(event) => onChange({ ...form, denoms: { ...form.denoms, [denom]: num(event.target.value) } })} />
            </label>
          ))}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary" onClick={onClose}>Cancelar</button>
          <button className="primary">Guardar cierre</button>
        </div>
      </form>
    </div>
  );
}

function MovementModal({ form, onClose, onChange, onSubmit }) {
  function setField(field, value) {
    onChange({ ...form, [field]: value });
  }

  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={(event) => { event.preventDefault(); onSubmit(form); }}>
        <div className="modal-head">
          <h3>Movimiento de caja</h3>
          <button type="button" className="icon-btn" onClick={onClose}>x</button>
        </div>
        <div className="form-grid">
          <label className="span-field-3">Fecha<input type="date" value={form.date} onChange={(event) => setField('date', event.target.value)} required /></label>
          <label className="span-field-3">Turno<select value={form.shiftName} onChange={(event) => setField('shiftName', event.target.value)} required><option>Turno dia</option><option>Turno noche</option></select></label>
          <label className="span-field-3">Tipo<select value={form.type} onChange={(event) => setField('type', event.target.value)} required><option value="ingreso">Ingreso</option><option value="gasto">Gasto</option><option value="retiro">Retiro / entrega al dueno</option></select></label>
          <label className="span-field-3">Monto<input type="number" min="0" step="0.01" value={form.amount} onChange={(event) => setField('amount', event.target.value)} required /></label>
          <label className="span-field-4">Empleado<input value={form.employeeName} onChange={(event) => setField('employeeName', event.target.value)} placeholder="Nombre" /></label>
          <label className="span-field-8">Motivo<input value={form.reason} onChange={(event) => setField('reason', event.target.value)} placeholder="Ej: almuerzos, transporte, venta, ajuste" required /></label>
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary" onClick={onClose}>Cancelar</button>
          <button className="primary">Guardar movimiento</button>
        </div>
      </form>
    </div>
  );
}

function Metric({ title, value, note }) {
  return <div className="panel metric span-3 private"><span>{title}</span><strong>{value}</strong><small>{note}</small></div>;
}

function RowActions({ onEdit, onDelete }) {
  return <div className="row-actions"><button className="icon-btn" title="Editar" onClick={onEdit}>e</button><button className="icon-btn" title="Eliminar" onClick={onDelete}>x</button></div>;
}

function Empty({ text }) {
  return <div className="empty">{text}</div>;
}

function SyncStatus({ loading, error, updatedAt }) {
  if (loading) return <span className="sync">Conectando con Firestore...</span>;
  if (error) return <span className="sync error">Sin sincronizacion: {error}</span>;
  return <span className="sync ok-text">Sincronizado en tiempo real{updatedAt ? ` - ${timeText(updatedAt)}` : ''}</span>;
}

function readSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

function normalizeData(value) {
  return {
    ...defaultData,
    ...value,
    ownerPin: value?.ownerPin || value?.pin || defaultData.ownerPin,
    employeePin: value?.employeePin || defaultData.employeePin,
    shifts: Array.isArray(value?.shifts) ? value.shifts : []
  };
}

function openShiftForm(shifts, activeDate, id, ownerUnlocked, fallbackName) {
  const shift = shifts.find((item) => item.id === id);
  const date = shift?.date || activeDate;
  const shiftName = shift?.shiftName || 'Turno dia';
  return {
    id: shift?.id || '',
    date,
    shiftName,
    employeeName: shift?.employeeName || fallbackName || '',
    openingCash: shift?.openingCash ?? autoOpeningCash(shifts, date, shiftName),
    purchaseTotal: shift?.purchaseTotal ?? 0,
    status: shift?.status || 'cerrado',
    notes: shift?.notes || '',
    denoms: denominations.reduce((acc, denom) => ({ ...acc, [denom]: shift?.denoms?.[denom] ?? 0 }), {})
  };
}

function openMovementForm(shifts, activeDate, id, movementType, fallbackName) {
  const movement = shifts.flatMap((shift) => (shift.movements || []).map((item) => ({ ...item, date: shift.date, shiftName: shift.shiftName }))).find((item) => item.id === id);
  return {
    id: movement?.id || '',
    date: movement?.date || activeDate,
    shiftName: movement?.shiftName || 'Turno dia',
    type: movement?.type || movementType || 'gasto',
    amount: movement?.amount ?? 0,
    employeeName: movement?.employeeName || fallbackName || '',
    reason: movement?.reason || ''
  };
}

function addMovementToShift(shifts, date, shiftName, movement) {
  const existing = findShift(shifts, date, shiftName);
  const shift = existing || {
    id: uid(),
    date,
    shiftName,
    employeeName: movement.employeeName,
    openingCash: autoOpeningCash(shifts, date, shiftName),
    purchaseTotal: 0,
    status: 'abierto',
    notes: '',
    denoms: {},
    movements: [],
    savedAt: new Date().toISOString()
  };
  const next = { ...shift, employeeName: shift.employeeName || movement.employeeName, movements: upsert(shift.movements || [], movement), savedAt: new Date().toISOString() };
  return upsert(shifts, next);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
}

function num(value) {
  return Number(value || 0);
}

function cents(value) {
  return Math.round(num(value) * 100);
}

function fromCents(value) {
  return value / 100;
}

function cashLeft(denoms) {
  return Object.entries(denoms || {}).reduce((sum, [denom, count]) => sum + cents(denom) * num(count), 0);
}

function movementTotals(shift) {
  const totals = { ingreso: cents(shift.otherIncome), gasto: cents(shift.expenseTotal), retiro: cents(shift.ownerWithdrawals) };
  (shift.movements || []).forEach((movement) => {
    totals[movement.type] = (totals[movement.type] || 0) + cents(movement.amount);
  });
  return totals;
}

function expectedLeft(shift) {
  const totals = movementTotals(shift);
  return cents(shift.openingCash) + totals.ingreso - cents(shift.purchaseTotal) - totals.gasto - totals.retiro;
}

function shiftDiff(shift) {
  return cashLeft(shift.denoms) - expectedLeft(shift);
}

function dayShifts(shifts, date) {
  return shifts.filter((shift) => shift.date === date).sort((a, b) => a.shiftName.localeCompare(b.shiftName));
}

function findShift(shifts, date, shiftName) {
  return shifts.find((shift) => shift.date === date && shift.shiftName === shiftName);
}

function previousDate(date) {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() - 1);
  return value.toISOString().slice(0, 10);
}

function previousShift(shifts, date, shiftName) {
  if (shiftName === 'Turno noche') return findShift(shifts, date, 'Turno dia');
  return findShift(shifts, previousDate(date), 'Turno noche');
}

function autoOpeningCash(shifts, date, shiftName) {
  return fromCents(cashLeft(previousShift(shifts, date, shiftName)?.denoms));
}

function upsert(list, item) {
  const exists = list.some((entry) => entry.id === item.id);
  return exists ? list.map((entry) => entry.id === item.id ? item : entry) : [item, ...list];
}

function diffClass(diff) {
  if (Math.abs(diff) < 1) return 'ok';
  return diff > 0 ? 'warn' : 'bad';
}

function diffText(diff) {
  if (Math.abs(diff) < 1) return 'Cuadra';
  return diff > 0 ? 'Sobra' : 'Falta';
}

function timeText(value) {
  if (!value) return '';
  return new Date(value).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
}

createRoot(document.getElementById('root')).render(<App />);
