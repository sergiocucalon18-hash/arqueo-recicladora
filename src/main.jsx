import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { signInAnonymously } from 'firebase/auth';
import { doc, getDoc, onSnapshot, setDoc } from 'firebase/firestore';
import { auth, db } from './firebase';
import './styles.css';

const DATA_REF = doc(db, 'arqueos', 'almetales');
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';
const SESSION_KEY = 'arqueo-recicladora-session';
const ACTIVE_CASH_BOX_KEY = 'almetales-active-cash-box';
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const denominations = [20, 10, 5, 1, 0.5, 0.25, 0.1, 0.05];
const defaultData = { ownerPin: '1234', employeePin: 'empleado', shifts: [], updatedAt: '' };
const defaultCompras = { fecha: '', totalDiario: 0, totalPesoKg: 0, cantidadRegistros: 0, porJornada: {}, compras: [], opciones: null, actualizadoEn: '' };
const defaultReportOptions = { materiales: [], jornadas: ['DIURNA', 'NOCTURNA'] };
const shiftOptions = ['Turno dia', 'Turno noche'];

function App() {
  const [data, setData] = useState(defaultData);
  const [comprasDiarias, setComprasDiarias] = useState(defaultCompras);
  const [loading, setLoading] = useState(true);
  const [authReady, setAuthReady] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [comprasError, setComprasError] = useState('');
  const [session, setSession] = useState(() => readSession());
  const [activeView, setActiveView] = useState(session?.role === 'owner' ? 'owner' : 'employee');
  const [activeDate, setActiveDate] = useState(today());
  const [activeCashBox, setActiveCashBox] = useState(() => readActiveCashBox());
  const [ownerShiftFilter, setOwnerShiftFilter] = useState('');
  const [deleteUnlocked, setDeleteUnlocked] = useState(false);
  const [shiftModal, setShiftModal] = useState(null);
  const [movementModal, setMovementModal] = useState(null);

  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;

    async function start() {
      try {
        await signInAnonymously(auth);
        setAuthReady(true);
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

  useEffect(() => {
    if (!authReady || !activeDate) return undefined;
    let active = true;
    const comprasRef = doc(db, 'compras_diarias', activeDate);
    const unsubscribe = onSnapshot(
      comprasRef,
      (snapshot) => {
        if (!active) return;
        setComprasDiarias(snapshot.exists() ? normalizeCompras(snapshot.data(), activeDate) : { ...defaultCompras, fecha: activeDate });
        setComprasError('');
      },
      (error) => {
        if (!active) return;

        if (error.code === 'permission-denied') {
          fetchComprasFromApi(activeDate)
            .then((payload) => {
              if (!active) return;
              setComprasDiarias(normalizeCompras(payload, activeDate));
              setComprasError('');
            })
            .catch((apiError) => {
              if (!active) return;
              setComprasError(`Firestore bloqueo la lectura de compras y la API local no respondio: ${apiError.message}`);
            });
          return;
        }

        setComprasError(error.message);
      }
    );

    return () => {
      active = false;
      unsubscribe();
    };
  }, [authReady, activeDate]);

  useEffect(() => {
    if (session?.role !== 'owner' && activeCashBox?.date && activeDate !== activeCashBox.date) {
      setActiveDate(activeCashBox.date);
    }
  }, [activeCashBox?.date, activeDate, session?.role]);

  useEffect(() => {
    if (!activeCashBox) return;
    const currentShift = findShift(data.shifts, activeCashBox.date, activeCashBox.shiftName);
    if (currentShift?.status === 'cerrado') clearActiveCashBox();
  }, [data.shifts, activeCashBox?.date, activeCashBox?.shiftName]);

  const ownerUnlocked = session?.role === 'owner';
  const dayItems = useMemo(() => dayShifts(data.shifts, activeDate), [data.shifts, activeDate]);
  const employeeShift = activeCashBox ? findShift(data.shifts, activeCashBox.date, activeCashBox.shiftName) : null;
  const employeeItems = activeCashBox ? [employeeShift].filter(Boolean) : [];
  const ownerItems = useMemo(
    () => dayItems.filter((shift) => !ownerShiftFilter || shift.shiftName === ownerShiftFilter),
    [dayItems, ownerShiftFilter]
  );
  const pageCopy = {
    employee: ['Registrar caja del turno', 'Registra ingresos, gastos y cierre de efectivo del turno.'],
    owner: ['Revision privada del dueno', 'Cuadres, diferencias, reportes y edicion completa.'],
    reports: ['Reportes de compras', 'Consulta compras por material, jornada, dia completo o rangos de fecha y hora.'],
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

  async function openCashBox(form) {
    const date = form.date || today();
    const shiftName = form.shiftName;
    const existing = findShift(data.shifts, date, shiftName);

    if (existing?.status === 'cerrado') {
      alert('Ese turno ya esta cerrado. Para revisarlo o corregirlo entra en Revision dueno.');
      return;
    }

    const nextCashBox = { date, shiftName };
    let nextShifts = data.shifts;

    if (!existing) {
      const shift = createOpenShift(data.shifts, date, shiftName, session?.name, comprasDiarias);
      nextShifts = upsert(data.shifts, shift);
      await persist({ ...data, shifts: nextShifts });
    }

    setActiveDate(date);
    setActiveCashBox(nextCashBox);
    localStorage.setItem(ACTIVE_CASH_BOX_KEY, JSON.stringify(nextCashBox));
  }

  async function updateOpeningCash(form) {
    if (form.ownerPin !== data.ownerPin) {
      alert('Clave de dueno incorrecta.');
      return;
    }

    const openingCashText = String(form.openingCash ?? '').trim().replace(',', '.');
    const openingCash = Number(openingCashText);

    if (!openingCashText || Number.isNaN(openingCash) || openingCash < 0) {
      alert('Ingresa un saldo inicial valido.');
      return;
    }

    const existing = findShift(data.shifts, form.date, form.shiftName);
    const base = existing || createOpenShift(data.shifts, form.date, form.shiftName, session?.name, comprasDiarias);
    const nextShift = {
      ...base,
      openingCash,
      savedAt: new Date().toISOString()
    };

    await persist({ ...data, shifts: upsert(data.shifts, nextShift) });
  }

  function clearActiveCashBox() {
    localStorage.removeItem(ACTIVE_CASH_BOX_KEY);
    setActiveCashBox(null);
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
      openingCash: ownerUnlocked ? num(form.openingCash) : num(existing?.openingCash ?? form.openingCash ?? autoOpeningCash(data.shifts, form.date, form.shiftName)),
      purchaseTotal: num(form.purchaseTotal),
      status: 'cerrado',
      notes: form.notes.trim(),
      denoms: normalizeDenoms(form.denoms),
      otherCashAmount: num(form.otherCashAmount),
      otherCashReason: String(form.otherCashReason || '').trim(),
      movements: existing?.movements || [],
      savedAt: new Date().toISOString()
    };
    await persist({ ...data, shifts: upsert(data.shifts, shift) });
    setShiftModal(null);
    if (activeCashBox?.date === form.date && activeCashBox?.shiftName === form.shiftName) {
      clearActiveCashBox();
    }
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
            <h1>ALMETALES</h1>
            <span>Turno dia y turno noche</span>
          </div>
        </div>

        <nav className="nav" aria-label="Navegacion principal">
          <button className={activeView === 'employee' ? 'active' : ''} onClick={() => setActiveView('employee')}>Registrar turno</button>
          {ownerUnlocked && <button className={activeView === 'owner' ? 'active' : ''} onClick={() => setActiveView('owner')}>Revision dueno</button>}
          {ownerUnlocked && <button className={activeView === 'reports' ? 'active' : ''} onClick={() => setActiveView('reports')}>Reportes</button>}
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
            {ownerUnlocked && <ComprasSyncStatus compras={comprasDiarias} error={comprasError} />}
          </div>
          <div className="toolbar">
            <input type="date" value={activeDate} onChange={(event) => setActiveDate(event.target.value)} aria-label="Fecha activa" />
            <button className="secondary" onClick={() => window.print()}>Imprimir</button>
            {ownerUnlocked && <button className="primary" onClick={exportData}>Exportar respaldo</button>}
          </div>
        </div>

        {activeView === 'employee' && (
          <EmployeeView
            shifts={employeeItems}
            activeCashBox={activeCashBox}
            deleteUnlocked={deleteUnlocked}
            onOpenCashBox={openCashBox}
            onUpdateOpeningCash={updateOpeningCash}
            onOpenShift={() => {
              if (!activeCashBox) {
                alert('Primero abre una caja para DIURNA o NOCTURNA.');
                return;
              }
              setShiftModal(openShiftForm(data.shifts, activeCashBox.date, null, ownerUnlocked, session.name, comprasDiarias, activeCashBox.shiftName));
            }}
            onOpenMovement={(type) => {
              if (!activeCashBox) {
                alert('Primero abre una caja para DIURNA o NOCTURNA.');
                return;
              }
              setMovementModal(openMovementForm(data.shifts, activeCashBox.date, null, type, session.name, activeCashBox.shiftName, true));
            }}
            onDeleteMovement={deleteMovement}
            onUnlockDelete={unlockEmployeeDelete}
            onLockDelete={() => setDeleteUnlocked(false)}
          />
        )}

        {activeView === 'owner' && ownerUnlocked && (
          <OwnerView
            shifts={ownerItems}
            compras={comprasDiarias}
            activeDate={activeDate}
            shiftFilter={ownerShiftFilter}
            onDateChange={setActiveDate}
            onShiftFilterChange={setOwnerShiftFilter}
            onOpenShift={(id) => setShiftModal(openShiftForm(data.shifts, activeDate, id, ownerUnlocked, session.name, comprasDiarias))}
            onOpenMovement={(id) => setMovementModal(openMovementForm(data.shifts, activeDate, id, 'gasto', session.name))}
            onDeleteShift={deleteShift}
            onDeleteMovement={deleteMovement}
          />
        )}

        {activeView === 'reports' && ownerUnlocked && (
          <ReportsView activeDate={activeDate} />
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
          compras={comprasDiarias}
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
            <h1>ALMETALES</h1>
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

function EmployeeView({ shifts, activeCashBox, deleteUnlocked, onOpenCashBox, onUpdateOpeningCash, onOpenShift, onOpenMovement, onDeleteMovement, onUnlockDelete, onLockDelete }) {
  const currentShift = shifts[0] || null;
  const movements = shifts.flatMap((shift) => (shift.movements || []).map((movement) => ({ ...movement, shiftName: shift.shiftName, shiftId: shift.id })));
  const incomes = movements.filter((movement) => movement.type === 'ingreso');
  const expenses = movements.filter((movement) => movement.type === 'gasto' || movement.type === 'retiro');
  const incomeTotal = incomes.reduce((sum, movement) => sum + cents(movement.amount), 0);
  const expenseTotal = expenses.reduce((sum, movement) => sum + cents(movement.amount), 0);

  function requestOpeningCashUpdate() {
    if (!activeCashBox) return;

    const ownerPin = prompt('Clave del dueno para corregir el saldo inicial:');
    if (ownerPin === null) return;

    const openingCash = prompt('Nuevo saldo inicial recibido:', currentShift?.openingCash ? String(currentShift.openingCash) : '');
    if (openingCash === null) return;

    onUpdateOpeningCash({
      date: activeCashBox.date,
      shiftName: activeCashBox.shiftName,
      openingCash,
      ownerPin
    });
  }

  return (
    <section className="grid">
      <div className="panel span-12 intro-panel">
        <div className="section-title">
          <h3>{activeCashBox ? `Caja abierta: ${shiftShortName(activeCashBox.shiftName)}` : 'Abrir caja'}</h3>
          {activeCashBox && <button className="primary" onClick={onOpenShift}>Cerrar caja</button>}
        </div>
        {!activeCashBox ? <CashBoxStarter onOpen={onOpenCashBox} /> : (
          <div className="cash-open-summary">
            <div>
              <span>Saldo inicial recibido</span>
              <strong>{money.format(num(currentShift?.openingCash))}</strong>
              <small>Fecha {activeCashBox.date}. Viene del efectivo dejado por el turno anterior.</small>
            </div>
            <button className="secondary" type="button" onClick={requestOpeningCashUpdate}>Corregir con clave</button>
          </div>
        )}
      </div>
      {activeCashBox && (
        <>
          <MovementBox title="Ingresos registrados" total={incomeTotal} status="ok" movements={incomes} emptyText="No hay ingresos registrados para esta caja." canDelete={deleteUnlocked} onAdd={() => onOpenMovement('ingreso')} onDelete={onDeleteMovement} />
          <MovementBox title="Gastos registrados" total={expenseTotal} status="bad" movements={expenses} emptyText="No hay gastos registrados para esta caja." canDelete={deleteUnlocked} onAdd={() => onOpenMovement('gasto')} onDelete={onDeleteMovement} />
        </>
      )}
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

function CashBoxStarter({ onOpen }) {
  const [date, setDate] = useState(today());
  const [shiftName, setShiftName] = useState('Turno dia');

  return (
    <form className="form-grid cash-starter" onSubmit={(event) => { event.preventDefault(); onOpen({ date, shiftName }); }}>
      <label className="span-field-4">Fecha
        <input type="date" value={date} onChange={(event) => setDate(event.target.value)} required />
      </label>
      <label className="span-field-4">Jornada
        <select value={shiftName} onChange={(event) => setShiftName(event.target.value)} required>
          <option value="Turno dia">DIURNA</option>
          <option value="Turno noche">NOCTURNA</option>
        </select>
      </label>
      <div className="span-field-4 cash-starter-action">
        <button className="primary">Abrir caja</button>
      </div>
    </form>
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

function OwnerView({ shifts, compras, activeDate, shiftFilter, onDateChange, onShiftFilterChange, onOpenShift, onOpenMovement, onDeleteShift, onDeleteMovement }) {
  const syncedPurchases = shiftFilter ? purchaseTotalForShift(compras, shiftFilter) : num(compras.totalDiario);
  const purchases = compras.cantidadRegistros ? cents(syncedPurchases) : shifts.reduce((sum, shift) => sum + cents(shift.purchaseTotal), 0);
  const incomes = shifts.reduce((sum, shift) => sum + movementTotals(shift).ingreso, 0);
  const expenses = shifts.reduce((sum, shift) => sum + movementTotals(shift).gasto + movementTotals(shift).retiro, 0);
  const left = shifts.reduce((sum, shift) => sum + shiftCashLeft(shift), 0);
  const diff = shifts.reduce((sum, shift) => sum + shiftDiff(shift), 0);

  return (
    <section className="grid">
      <div className="panel span-12 private">
        <div className="section-title"><h3>Filtros de revision</h3></div>
        <div className="form-grid">
          <label className="span-field-4">Fecha
            <input type="date" value={activeDate} onChange={(event) => onDateChange(event.target.value)} />
          </label>
          <label className="span-field-4">Jornada
            <select value={shiftFilter} onChange={(event) => onShiftFilterChange(event.target.value)}>
              <option value="">Todas las jornadas</option>
              <option value="Turno dia">DIURNA</option>
              <option value="Turno noche">NOCTURNA</option>
            </select>
          </label>
          <div className="span-field-4 filter-summary">
            <span className="status info">{shiftFilter ? shiftShortName(shiftFilter) : 'Dia completo'}</span>
          </div>
        </div>
      </div>
      <Metric title="Compras reportadas" value={money.format(fromCents(purchases))} note={compras.cantidadRegistros ? `${compras.cantidadRegistros} registros sincronizados` : 'Sistema de pesaje'} />
      <Metric title="Ingresos totales" value={money.format(fromCents(incomes))} note="Ventas y entradas a caja" />
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
                <tr><th>Turno</th><th>Empleado</th><th>Inicial</th><th>Ingresos</th><th>Gastos</th><th>Retiros</th><th>Compras</th><th>Esperado</th><th>Dejado</th><th>Diferencia</th><th>Accion</th></tr>
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
  const left = shiftCashLeft(shift);
  const diff = shiftDiff(shift);
  return (
    <>
      <tr>
        <td>{shift.shiftName}</td>
        <td>{shift.employeeName || '-'}</td>
        <td>{money.format(num(shift.openingCash))}</td>
        <td>{money.format(fromCents(totals.ingreso))}</td>
        <td>{money.format(fromCents(totals.gasto))}</td>
        <td>{money.format(fromCents(totals.retiro))}</td>
        <td>{money.format(num(shift.purchaseTotal))}</td>
        <td>{money.format(fromCents(expected))}</td>
        <td>{money.format(fromCents(left))}</td>
        <td><span className={`status ${diffClass(diff)}`}>{diffText(diff)} {money.format(Math.abs(fromCents(diff)))}</span></td>
        <td><RowActions onEdit={() => onOpenShift(shift.id)} onDelete={() => onDeleteShift(shift.id)} /></td>
      </tr>
      {(shift.movements || []).length === 0 && <tr><td colSpan="11" className="muted">Sin movimientos registrados durante el turno.</td></tr>}
      {(shift.movements || []).map((movement) => (
        <tr key={movement.id} className="subrow">
          <td colSpan="3">{timeText(movement.savedAt)}</td>
          <td colSpan="5"><span className={`status mini ${movement.type === 'ingreso' ? 'ok' : movement.type === 'retiro' ? 'warn' : 'bad'}`}>{movement.type}</span> {movement.reason}</td>
          <td>{money.format(num(movement.amount))}</td>
          <td>{movement.employeeName || '-'}</td>
          <td><RowActions onEdit={() => onOpenMovement(movement.id)} onDelete={() => onDeleteMovement(shift.id, movement.id)} /></td>
        </tr>
      ))}
      {num(shift.otherCashAmount) > 0 && (
        <tr className="subrow">
          <td colSpan="3">Otros efectivo</td>
          <td colSpan="5">{shift.otherCashReason || 'Sin detalle'}</td>
          <td>{money.format(num(shift.otherCashAmount))}</td>
          <td>{shift.employeeName || '-'}</td>
          <td></td>
        </tr>
      )}
      {shift.notes && <tr><td colSpan="11" className="muted">Notas: {shift.notes}</td></tr>}
    </>
  );
}

function ReportsView({ activeDate }) {
  const [options, setOptions] = useState(defaultReportOptions);
  const [filters, setFilters] = useState(() => defaultReportFilters(activeDate));
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setFilters((current) => current.desde || current.hasta ? current : defaultReportFilters(activeDate));
  }, [activeDate]);

  useEffect(() => {
    let active = true;
    let timer = null;

    async function loadOptions() {
      try {
        const nextOptions = await fetchReportOptionsFromApi();
        if (active) setOptions((current) => mergeReportOptions(current, nextOptions));
      } catch (_error) {
        try {
          const nextOptions = await loadGlobalReportOptionsFromFirestore(activeDate);
          if (active) setOptions((current) => mergeReportOptions(current, nextOptions));
        } catch (_globalError) {
          try {
            const nextOptions = await loadReportOptionsFromFirestore(defaultReportFilters(activeDate));
            if (active) setOptions((current) => mergeReportOptions(current, nextOptions));
          } catch (_firestoreError) {
            if (active) setOptions(defaultReportOptions);
          }
        }
      }
    }

    loadOptions();
    timer = setInterval(loadOptions, 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [activeDate]);

  async function generateReport(event) {
    event?.preventDefault();
    setLoading(true);
    setError('');
    try {
      const payload = await fetchReportFromApi(filters);
      setOptions((current) => mergeReportOptions(current, optionsFromCompras(payload.compras || [])));
      setReport(payload);
    } catch (_apiError) {
      try {
        const payload = await generateReportFromFirestore(filters);
        setOptions((current) => mergeReportOptions(current, optionsFromCompras(payload.compras || [])));
        setReport(payload);
      } catch (firestoreError) {
        setError(`No se pudo generar el reporte desde Vercel. Revisa que las compras esten sincronizadas en Firestore. Detalle: ${firestoreError.message}`);
      }
    } finally {
      setLoading(false);
    }
  }

  async function fetchReportFromApi(currentFilters) {
    const params = new URLSearchParams();
    Object.entries(currentFilters).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    const response = await fetch(`${API_BASE_URL}/reporte-compras?${params.toString()}`);
    const payload = await readJson(response);

    if (!response.ok) {
      throw new Error(payload?.error || 'No se pudo generar el reporte.');
    }

    return payload;
  }

  async function fetchReportOptionsFromApi() {
    const response = await fetch(`${API_BASE_URL}/compras-opciones`);
    const payload = await readJson(response);

    if (!response.ok) {
      throw new Error(payload?.error || 'No se pudieron cargar materiales y jornadas.');
    }

    return payload;
  }

  async function generateReportFromFirestore(currentFilters) {
    const desde = normalizeReportDateTime(currentFilters.desde);
    const hasta = normalizeReportDateTime(currentFilters.hasta);
    const material = trimReportText(currentFilters.material);
    const jornada = trimReportText(currentFilters.jornada);

    if (!desde || !hasta) {
      throw new Error('Debes elegir desde y hasta.');
    }

    const compras = await loadComprasFromFirestore({ desde, hasta });
    const filtered = compras
      .map(normalizeCompraForReport)
      .filter((compra) => {
        const compraDateTime = compraDateTimeText(compra);
        if (compraDateTime < desde || compraDateTime > hasta) return false;
        if (material && normalizeText(compra.material) !== normalizeText(material)) return false;
        if (jornada && normalizeText(compra.jornada) !== normalizeText(jornada)) return false;
        return true;
      })
      .sort((a, b) => compraDateTimeText(a).localeCompare(compraDateTimeText(b)) || a.material.localeCompare(b.material));

    return summarizeReport(filtered, { desde, hasta, material, jornada });
  }

  async function loadReportOptionsFromFirestore(currentFilters) {
    const compras = await loadComprasFromFirestore({
      desde: currentFilters.desde,
      hasta: currentFilters.hasta
    });
    return optionsFromCompras(compras);
  }

  async function loadGlobalReportOptionsFromFirestore(date) {
    const candidates = [...new Set([date, today()])];

    for (const candidate of candidates) {
      const snapshot = await getDoc(doc(db, 'compras_diarias', candidate));
      if (!snapshot.exists()) continue;

      const options = normalizeReportOptions(snapshot.data()?.opciones);
      if (options.materiales.length || options.jornadas.length) return options;
    }

    throw new Error('Sin opciones sincronizadas.');
  }

  async function loadComprasFromFirestore(currentFilters) {
    const desde = normalizeReportDateTime(currentFilters.desde);
    const hasta = normalizeReportDateTime(currentFilters.hasta);
    const dates = datesBetween(desde.slice(0, 10), hasta.slice(0, 10));

    const snapshots = await Promise.all(dates.map((date) => getDoc(doc(db, 'compras_diarias', date))));
    return snapshots.flatMap((snapshot, index) => {
      if (!snapshot.exists()) return [];
      return normalizeCompras(snapshot.data(), dates[index]).compras;
    });
  }

  function summarizeReport(compras, filtros) {
    const totalSubtotal = roundMoney(compras.reduce((sum, compra) => sum + num(compra.subtotal), 0));
    const totalPesoKg = roundWeight(compras.reduce((sum, compra) => sum + num(compra.peso_neto_kg), 0));
    const porMaterial = groupReportTotals(compras, 'material');
    const porJornada = groupReportTotals(compras, 'jornada');
    const porMaterialJornada = compras.reduce((acc, compra) => {
      const materialName = compra.material || 'Sin material';
      const jornadaName = compra.jornada || 'Sin jornada';
      const key = `${materialName} / ${jornadaName}`;
      const current = acc[key] || {
        material: materialName,
        jornada: jornadaName,
        totalSubtotal: 0,
        totalPesoKg: 0,
        cantidadRegistros: 0
      };
      current.totalSubtotal = roundMoney(current.totalSubtotal + num(compra.subtotal));
      current.totalPesoKg = roundWeight(current.totalPesoKg + num(compra.peso_neto_kg));
      current.cantidadRegistros += 1;
      acc[key] = current;
      return acc;
    }, {});

    return {
      filtros,
      totalSubtotal,
      totalPesoKg,
      cantidadRegistros: compras.length,
      porMaterial,
      porJornada,
      porMaterialJornada,
      compras,
      generadoEn: new Date().toISOString()
    };
  }

  function groupReportTotals(compras, field) {
    return compras.reduce((acc, compra) => {
      const fallback = field === 'material' ? 'Sin material' : 'Sin jornada';
      const name = compra[field] || fallback;
      const current = acc[name] || { nombre: name, totalSubtotal: 0, totalPesoKg: 0, cantidadRegistros: 0 };
      current.totalSubtotal = roundMoney(current.totalSubtotal + num(compra.subtotal));
      current.totalPesoKg = roundWeight(current.totalPesoKg + num(compra.peso_neto_kg));
      current.cantidadRegistros += 1;
      acc[name] = current;
      return acc;
    }, {});
  }

  function normalizeCompraForReport(compra, index) {
    const fecha = String(compra?.fecha || '').slice(0, 10);
    const hora = normalizeReportTime(compra?.hora_registro_salida);
    const material = trimReportText(compra?.material);
    const jornada = trimReportText(compra?.jornada);

    return {
      id: compra?.id || `${fecha}-${hora}-${material}-${jornada}-${index}`,
      fecha,
      material,
      peso_neto_kg: num(compra?.peso_neto_kg),
      subtotal: num(compra?.subtotal),
      hora_registro_salida: hora,
      jornada
    };
  }

  function optionsFromCompras(compras) {
    return {
      materiales: uniqueSorted(compras.map((compra) => trimReportText(compra.material)).filter(Boolean)),
      jornadas: normalizeReportJornadas(compras.map((compra) => compra.jornada))
    };
  }

  function normalizeReportOptions(value) {
    const materiales = Array.isArray(value?.materiales) ? value.materiales : [];
    const jornadas = Array.isArray(value?.jornadas) ? value.jornadas : [];
    return {
      materiales: uniqueSorted(materiales.map(trimReportText).filter(Boolean)),
      jornadas: normalizeReportJornadas(jornadas)
    };
  }

  function mergeReportOptions(current, next) {
    return {
      materiales: uniqueSorted([...(current.materiales || []), ...(next.materiales || [])]),
      jornadas: normalizeReportJornadas([
        ...defaultReportOptions.jornadas,
        ...(current.jornadas || []),
        ...(next.jornadas || [])
      ])
    };
  }

  function uniqueSorted(values) {
    return [...new Set(values)].sort((a, b) => a.localeCompare(b));
  }

  function normalizeReportJornadas(values) {
    return uniqueSorted(values.map(normalizeReportJornada).filter(Boolean));
  }

  function normalizeReportJornada(value) {
    const text = normalizeText(value);
    if (text.includes('diurna') || text === '1') return 'DIURNA';
    if (text.includes('noctur') || text.includes('noche') || text === '2') return 'NOCTURNA';
    return '';
  }

  function normalizeReportDateTime(value) {
    const text = String(value || '').replace(' ', 'T').trim();
    if (!text) return '';
    if (text.length === 10) return `${text}T00:00:00`;
    if (text.length === 16) return `${text}:00`;
    return text.slice(0, 19);
  }

  function normalizeReportTime(value) {
    const text = String(value || '').trim();
    if (!text) return '00:00:00';
    const time = text.includes('T') ? text.slice(11, 19) : text.slice(0, 8);
    return time.length === 5 ? `${time}:00` : time || '00:00:00';
  }

  function compraDateTimeText(compra) {
    return `${compra.fecha}T${normalizeReportTime(compra.hora_registro_salida)}`;
  }

  function datesBetween(startDate, endDate) {
    const dates = [];
    const current = new Date(`${startDate}T12:00:00`);
    const end = new Date(`${endDate}T12:00:00`);

    if (Number.isNaN(current.getTime()) || Number.isNaN(end.getTime()) || current > end) {
      return dates;
    }

    while (current <= end) {
      dates.push(current.toISOString().slice(0, 10));
      current.setDate(current.getDate() + 1);
    }

    return dates;
  }

  function trimReportText(value) {
    return String(value || '').trim();
  }

  function roundMoney(value) {
    return Math.round(num(value) * 100) / 100;
  }

  function roundWeight(value) {
    return Math.round(num(value) * 1000) / 1000;
  }

  function updateFilter(field, value) {
    setFilters((current) => ({ ...current, [field]: value }));
  }

  function closeDatePicker(event) {
    event.currentTarget.parentElement?.querySelector('input')?.blur();
  }

  function setFullDay() {
    setFilters((current) => ({ ...current, desde: `${activeDate}T00:00`, hasta: `${activeDate}T23:59` }));
  }

  function clearFilters() {
    setFilters(defaultReportFilters(activeDate));
    setReport(null);
    setError('');
  }

  return (
    <section className="grid reports-view">
      <div className="panel span-12">
        <div className="section-title">
          <h3>Filtros del reporte</h3>
          <div className="toolbar">
            <button type="button" className="secondary" onClick={setFullDay}>Dia completo</button>
            <button type="button" className="secondary" onClick={clearFilters}>Limpiar</button>
          </div>
        </div>
        <form className="form-grid" onSubmit={generateReport}>
          <label className="span-field-3">Desde
            <div className="input-action">
              <input type="datetime-local" value={filters.desde} onChange={(event) => updateFilter('desde', event.target.value)} required />
              <button type="button" className="input-ok" onClick={closeDatePicker}>OK</button>
            </div>
          </label>
          <label className="span-field-3">Hasta
            <div className="input-action">
              <input type="datetime-local" value={filters.hasta} onChange={(event) => updateFilter('hasta', event.target.value)} required />
              <button type="button" className="input-ok" onClick={closeDatePicker}>OK</button>
            </div>
          </label>
          <label className="span-field-3">Material
            <select value={filters.material} onChange={(event) => updateFilter('material', event.target.value)}>
              <option value="">Todos los materiales</option>
              {options.materiales.map((material) => <option key={material} value={material}>{material}</option>)}
            </select>
          </label>
          <label className="span-field-3">Jornada
            <select value={filters.jornada} onChange={(event) => updateFilter('jornada', event.target.value)}>
              <option value="">Todas las jornadas</option>
              {options.jornadas.map((jornada) => <option key={jornada} value={jornada}>{jornada}</option>)}
            </select>
          </label>
          <div className="span-field-12 report-actions">
            <button className="primary" disabled={loading}>{loading ? 'Generando...' : 'Generar reporte'}</button>
            {report && <button type="button" className="secondary" onClick={() => exportReportCsv(report)}>Exportar CSV</button>}
          </div>
        </form>
        {error && <p className="error report-error">{error}</p>}
      </div>

      {!report && <div className="panel span-12"><Empty text="Elige un rango y genera un reporte para ver totales por material y jornada." /></div>}

      {report && (
        <>
          <Metric title="Total comprado" value={money.format(num(report.totalSubtotal))} note={`${report.cantidadRegistros} registros`} />
          <Metric title="Peso neto" value={`${num(report.totalPesoKg).toLocaleString('es-CO')} kg`} note="Suma del rango" />
          <Metric title="Materiales" value={Object.keys(report.porMaterial || {}).length} note="Con compras en el rango" />
          <Metric title="Generado" value={timeText(report.generadoEn)} note={`${dateText(report.filtros.desde)} a ${dateText(report.filtros.hasta)}`} />

          <div className="panel span-6">
            <div className="section-title"><h3>Por material y jornada</h3></div>
            <ReportSummaryTable rows={Object.values(report.porMaterialJornada || {})} columns={['material', 'jornada']} />
          </div>

          <div className="panel span-6">
            <div className="section-title"><h3>Por material</h3></div>
            <ReportSummaryTable rows={Object.values(report.porMaterial || {})} columns={['nombre']} />
          </div>

          <div className="panel span-12">
            <div className="section-title">
              <h3>Detalle de compras</h3>
              <span className="status info">{report.compras.length} registros</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Fecha</th><th>Hora</th><th>Material</th><th>Jornada</th><th>Peso kg</th><th>Subtotal</th></tr>
                </thead>
                <tbody>
                  {report.compras.map((compra) => (
                    <tr key={compra.id}>
                      <td>{compra.fecha}</td>
                      <td>{compra.hora_registro_salida}</td>
                      <td>{compra.material}</td>
                      <td>{compra.jornada || '-'}</td>
                      <td>{num(compra.peso_neto_kg).toLocaleString('es-CO')}</td>
                      <td>{money.format(num(compra.subtotal))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function ReportSummaryTable({ rows, columns }) {
  if (!rows.length) return <Empty text="No hay compras para estos filtros." />;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.includes('material') && <th>Material</th>}
            {columns.includes('jornada') && <th>Jornada</th>}
            {columns.includes('nombre') && <th>Nombre</th>}
            <th>Peso kg</th>
            <th>Subtotal</th>
            <th>Registros</th>
          </tr>
        </thead>
        <tbody>
          {rows
            .sort((a, b) => num(b.totalSubtotal) - num(a.totalSubtotal))
            .map((row) => (
              <tr key={`${row.material || row.nombre}-${row.jornada || ''}`}>
                {columns.includes('material') && <td>{row.material}</td>}
                {columns.includes('jornada') && <td>{row.jornada}</td>}
                {columns.includes('nombre') && <td>{row.nombre}</td>}
                <td>{num(row.totalPesoKg).toLocaleString('es-CO')}</td>
                <td>{money.format(num(row.totalSubtotal))}</td>
                <td>{row.cantidadRegistros}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
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

function ShiftModal({ form, ownerUnlocked, shifts, compras, onClose, onChange, onSubmit }) {
  const automatic = autoOpeningCash(shifts, form.date, form.shiftName);
  const syncedPurchases = purchaseTotalForShift(compras, form.shiftName);
  const denomTotal = money.format(fromCents(cashLeft(form.denoms, form.otherCashAmount)));

  useEffect(() => {
    const next = { ...form };
    if (!form.id) next.openingCash = automatic;
    if (!form.id && syncedPurchases > 0) next.purchaseTotal = syncedPurchases;
    if (next.openingCash !== form.openingCash || next.purchaseTotal !== form.purchaseTotal) onChange(next);
  }, [form.date, form.shiftName, syncedPurchases]);

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
          <label className="span-field-3">Fecha<input type="date" value={form.date} readOnly={form.lockShift} onChange={(event) => setField('date', event.target.value)} required /></label>
          <label className="span-field-3">Turno
            {form.lockShift ? (
              <input value={shiftShortName(form.shiftName)} readOnly />
            ) : (
              <select value={form.shiftName} onChange={(event) => setField('shiftName', event.target.value)} required>{shiftOptions.map((shift) => <option key={shift} value={shift}>{shiftShortName(shift)}</option>)}</select>
            )}
          </label>
          <label className="span-field-3">Empleado<input value={form.employeeName} onChange={(event) => setField('employeeName', event.target.value)} placeholder="Nombre" /></label>
          <label className="span-field-3">Saldo inicial recibido<input type="number" inputMode="decimal" min="0" step="0.01" value={numberInputValue(form.openingCash)} readOnly={!ownerUnlocked} onChange={(event) => setField('openingCash', event.target.value)} /><small>{ownerUnlocked ? `Puedes corregirlo. Automatico sugerido: ${money.format(automatic)}.` : `Viene del efectivo dejado por el turno anterior: ${money.format(automatic)}.`}</small></label>
          {ownerUnlocked && <label className="span-field-4">Total compras reciclaje<input type="number" inputMode="decimal" min="0" step="0.01" value={numberInputValue(form.purchaseTotal)} onChange={(event) => setField('purchaseTotal', event.target.value)} required /><small>{syncedPurchases > 0 ? `Sincronizado para este turno: ${money.format(syncedPurchases)}.` : 'Sin compras sincronizadas para este turno.'}</small></label>}
          <label className={ownerUnlocked ? 'span-field-4' : 'span-field-6'}>Estado del turno<input value="Cierre de caja" readOnly /></label>
          <label className={ownerUnlocked ? 'span-field-4' : 'span-field-6'}>Notas del cierre<input value={form.notes} onChange={(event) => setField('notes', event.target.value)} placeholder="Observacion final" /></label>
        </div>
        <div className="section-title denom-title">
          <h3>Efectivo que deja para el siguiente turno</h3>
          <span className="status info">{denomTotal}</span>
        </div>
        <div className="denoms">
          {denominations.map((denom) => (
            <label className="denom" key={denom}><b>{money.format(denom)}</b>
              <input type="number" inputMode="numeric" min="0" step="1" value={numberInputValue(form.denoms[denom])} onChange={(event) => onChange({ ...form, denoms: { ...form.denoms, [denom]: event.target.value } })} />
            </label>
          ))}
          <label className="denom denom-other"><b>Otros</b>
            <input type="number" inputMode="decimal" min="0" step="0.01" value={numberInputValue(form.otherCashAmount)} onChange={(event) => setField('otherCashAmount', event.target.value)} />
            <input value={form.otherCashReason} onChange={(event) => setField('otherCashReason', event.target.value)} placeholder="Motivo o detalle" />
          </label>
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
          <label className="span-field-3">Fecha<input type="date" value={form.date} readOnly={form.lockShift} onChange={(event) => setField('date', event.target.value)} required /></label>
          <label className="span-field-3">Turno
            {form.lockShift ? (
              <input value={shiftShortName(form.shiftName)} readOnly />
            ) : (
              <select value={form.shiftName} onChange={(event) => setField('shiftName', event.target.value)} required>{shiftOptions.map((shift) => <option key={shift} value={shift}>{shiftShortName(shift)}</option>)}</select>
            )}
          </label>
          <label className="span-field-3">Tipo<select value={form.type} onChange={(event) => setField('type', event.target.value)} required><option value="ingreso">Ingreso</option><option value="gasto">Gasto</option><option value="retiro">Retiro / entrega al dueno</option></select></label>
          <label className="span-field-3">Monto<input type="number" inputMode="decimal" min="0" step="0.01" value={numberInputValue(form.amount)} onChange={(event) => setField('amount', event.target.value)} required /></label>
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

function ComprasSyncStatus({ compras, error }) {
  if (error) return <span className="sync error">Compras MySQL sin sincronizar: {error}</span>;
  if (!compras.actualizadoEn) return <span className="sync">Compras MySQL pendientes para esta fecha.</span>;
  return <span className="sync ok-text">Compras MySQL: {money.format(num(compras.totalDiario))}</span>;
}

function defaultReportFilters(date = today()) {
  return {
    desde: `${date}T00:00`,
    hasta: `${date}T23:59`,
    material: '',
    jornada: ''
  };
}

function exportReportCsv(report) {
  const headers = ['fecha', 'hora_registro_salida', 'material', 'jornada', 'peso_neto_kg', 'subtotal'];
  const lines = [
    headers.join(','),
    ...report.compras.map((compra) => headers.map((key) => csvValue(compra[key])).join(','))
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `reporte-compras-${report.filtros.desde.slice(0, 10)}-${report.filtros.hasta.slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function csvValue(value) {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

function readSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

function readActiveCashBox() {
  try {
    const value = JSON.parse(localStorage.getItem(ACTIVE_CASH_BOX_KEY));
    if (!value?.date || !shiftOptions.includes(value?.shiftName)) return null;
    return { date: value.date, shiftName: value.shiftName };
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

function normalizeCompras(value, fecha) {
  return {
    ...defaultCompras,
    ...value,
    fecha: value?.fecha || fecha,
    totalDiario: num(value?.totalDiario),
    totalPesoKg: num(value?.totalPesoKg),
    cantidadRegistros: Number(value?.cantidadRegistros || 0),
    porJornada: value?.porJornada || {},
    compras: Array.isArray(value?.compras) ? value.compras : []
  };
}

async function fetchComprasFromApi(fecha) {
  const response = await fetch(`${API_BASE_URL}/compras?fecha=${encodeURIComponent(fecha)}`);
  const payload = await readJson(response);

  if (!response.ok) {
    throw new Error(payload?.error || 'No se pudieron cargar compras desde la API local.');
  }

  return payload;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (_error) {
    return null;
  }
}

function createOpenShift(shifts, date, shiftName, employeeName, compras = defaultCompras) {
  return {
    id: uid(),
    date,
    shiftName,
    employeeName: employeeName || '',
    openingCash: autoOpeningCash(shifts, date, shiftName),
    purchaseTotal: purchaseTotalForShift(compras, shiftName),
    status: 'abierto',
    notes: '',
    denoms: {},
    otherCashAmount: 0,
    otherCashReason: '',
    movements: [],
    savedAt: new Date().toISOString()
  };
}

function openShiftForm(shifts, activeDate, id, ownerUnlocked, fallbackName, compras = defaultCompras, forcedShiftName = '') {
  const shift = id
    ? shifts.find((item) => item.id === id)
    : forcedShiftName
      ? findShift(shifts, activeDate, forcedShiftName)
      : null;
  const date = shift?.date || activeDate;
  const shiftName = shift?.shiftName || forcedShiftName || 'Turno dia';
  const syncedPurchases = purchaseTotalForShift(compras, shiftName);
  return {
    id: shift?.id || '',
    date,
    shiftName,
    lockShift: Boolean(forcedShiftName),
    employeeName: shift?.employeeName || fallbackName || '',
    openingCash: shift?.openingCash ?? autoOpeningCash(shifts, date, shiftName),
    purchaseTotal: shift?.purchaseTotal ?? syncedPurchases,
    status: 'cerrado',
    notes: shift?.notes || '',
    denoms: denominations.reduce((acc, denom) => ({ ...acc, [denom]: shift?.denoms?.[denom] ?? '' }), {}),
    otherCashAmount: shift?.otherCashAmount ?? '',
    otherCashReason: shift?.otherCashReason || ''
  };
}

function openMovementForm(shifts, activeDate, id, movementType, fallbackName, forcedShiftName = '', lockShift = false) {
  const movement = shifts.flatMap((shift) => (shift.movements || []).map((item) => ({ ...item, date: shift.date, shiftName: shift.shiftName }))).find((item) => item.id === id);
  return {
    id: movement?.id || '',
    date: movement?.date || activeDate,
    shiftName: movement?.shiftName || forcedShiftName || 'Turno dia',
    lockShift,
    type: movement?.type || movementType || 'gasto',
    amount: movement?.amount ?? '',
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
    otherCashAmount: 0,
    otherCashReason: '',
    movements: [],
    savedAt: new Date().toISOString()
  };
  const next = { ...shift, employeeName: shift.employeeName || movement.employeeName, movements: upsert(shift.movements || [], movement), savedAt: new Date().toISOString() };
  return upsert(shifts, next);
}

function today() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
}

function num(value) {
  return Number(value || 0);
}

function numberInputValue(value) {
  if (value === 0 || value === '0' || value === null || value === undefined) return '';
  return value;
}

function normalizeDenoms(denoms = {}) {
  return denominations.reduce((acc, denom) => {
    const value = num(denoms[denom]);
    if (value > 0) acc[denom] = value;
    return acc;
  }, {});
}

function cents(value) {
  return Math.round(num(value) * 100);
}

function fromCents(value) {
  return value / 100;
}

function cashLeft(denoms, otherCashAmount = 0) {
  return Object.entries(denoms || {}).reduce((sum, [denom, count]) => sum + cents(denom) * num(count), cents(otherCashAmount));
}

function shiftCashLeft(shift) {
  return cashLeft(shift?.denoms, shift?.otherCashAmount);
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
  return shiftCashLeft(shift) - expectedLeft(shift);
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
  return fromCents(shiftCashLeft(previousShift(shifts, date, shiftName)));
}

function purchaseTotalForShift(compras, shiftName) {
  const entries = Object.values(compras?.porJornada || {});
  const matched = entries.filter((entry) => jornadaMatchesShift(entry.jornada, shiftName));
  return matched.reduce((sum, entry) => sum + num(entry.totalSubtotal), 0);
}

function jornadaMatchesShift(jornada, shiftName) {
  const value = normalizeText(jornada);
  const shift = normalizeText(shiftName);

  if (!value) return false;
  if (shift.includes('noche')) return value.includes('noche') || value.includes('noctur') || value === '2';
  if (shift.includes('dia')) return value.includes('dia') || value.includes('diurna') || value.includes('manana') || value === '1';

  return value === shift;
}

function shiftShortName(shiftName) {
  return shiftName === 'Turno noche' ? 'NOCTURNA' : 'DIURNA';
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
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

function dateText(value) {
  if (!value) return '';
  return String(value).replace('T', ' ').slice(0, 16);
}

createRoot(document.getElementById('root')).render(<App />);
