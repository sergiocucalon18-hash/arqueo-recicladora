import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { signInAnonymously } from 'firebase/auth';
import { doc, getDoc, onSnapshot, setDoc } from 'firebase/firestore';
import { auth, db } from './firebase';
import logoUrl from '../LOGO.png';
import './styles.css';

const DATA_REF = doc(db, 'arqueos', 'almetales');
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';
const SESSION_KEY = 'arqueo-recicladora-session';
const ACTIVE_CASH_BOX_KEY = 'almetales-active-cash-box';
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const denominations = [20, 10, 5, 1, 0.5, 0.25, 0.1, 0.05];
const defaultData = { ownerPin: '1234', employeePin: 'empleado', shifts: [], payrollAdjustments: [], employees: [], updatedAt: '' };
const defaultCompras = { fecha: '', totalDiario: 0, totalPesoKg: 0, cantidadRegistros: 0, porJornada: {}, compras: [], opciones: null, actualizadoEn: '' };
const defaultReportOptions = { materiales: [], jornadas: ['DIURNA', 'NOCTURNA'] };
const shiftOptions = ['Turno dia', 'Turno noche'];
const incomeTypes = [
  { value: 'general', label: 'Ingreso general' },
  { value: 'ventas', label: 'Ventas' }
];
const expenseTypes = [
  { value: 'gasto', label: 'Gasto' },
  { value: 'retiro', label: 'Retiro / entrega al dueno' }
];
const materialAuditTypes = [
  { value: 'nonFerrous', label: 'Metales no ferrosos', reportUnit: 'lb' },
  { value: 'standard', label: 'Pet, carton, chatarra u otros', reportUnit: 'kg' }
];
const payrollAdjustmentTypes = [
  { value: 'bono', label: 'Bono', sign: 1 },
  { value: 'extra', label: 'Extra', sign: 1 },
  { value: 'descuento', label: 'Descuento', sign: -1 }
];
const companyInfo = { name: 'ALMETALES', ruc: '0962596649001' };

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
    salaries: ['Sueldos empleados', 'Vales, bonos, extras y descuentos por rango de fechas.'],
    reports: ['Reportes de compras', 'Consulta compras por material, jornada, dia completo o rangos de fecha y hora.'],
    materials: ['Arqueo materiales', 'Compara inventario, recuperacion y peso reportado por recolector.'],
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
    const syncedPurchaseTotal = purchaseTotalForShift(comprasDiarias, form.shiftName);
    const purchaseTotal = ownerUnlocked
      ? num(form.purchaseTotal)
      : syncedPurchaseTotal > 0 ? syncedPurchaseTotal : num(existing?.purchaseTotal ?? form.purchaseTotal);
    const shift = {
      id,
      date: form.date,
      shiftName: form.shiftName,
      employeeName: form.employeeName.trim(),
      openingCash: ownerUnlocked ? num(form.openingCash) : num(existing?.openingCash ?? form.openingCash ?? autoOpeningCash(data.shifts, form.date, form.shiftName)),
      purchaseTotal,
      status: 'cerrado',
      notes: form.notes.trim(),
      denoms: normalizeDenoms(form.denoms),
      otherCashAmount: num(form.otherCashAmount),
      otherCashReason: String(form.otherCashReason || '').trim(),
      movements: existing?.movements || [],
      savedAt: new Date().toISOString()
    };
    const shifts = cascadeOpeningCash(upsert(data.shifts, shift), shift);
    await persist({ ...data, shifts });
    setShiftModal(null);
    if (activeCashBox?.date === form.date && activeCashBox?.shiftName === form.shiftName) {
      clearActiveCashBox();
    }
  }

  async function saveMovement(form) {
    if (num(form.amount) <= 0) {
      alert('Ingresa un monto mayor a cero.');
      return;
    }

    const selectedBeneficiary = form.type === 'vale'
      ? employeeFromForm(data.employees, form.beneficiaryId, form.beneficiaryName)
      : null;

    if (form.type === 'vale' && !selectedBeneficiary?.fullName) {
      alert('Selecciona el empleado que recibe el vale.');
      return;
    }

    const movement = {
      id: form.id || uid(),
      type: form.type,
      incomeType: form.type === 'ingreso' ? (form.incomeType || 'general') : '',
      amount: num(form.amount),
      reason: form.reason.trim() || movementTypeLabel(form.type, form.incomeType),
      employeeName: form.employeeName.trim(),
      beneficiaryId: form.type === 'vale' ? selectedBeneficiary.id : '',
      beneficiaryName: form.type === 'vale' ? selectedBeneficiary.fullName : '',
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

  async function savePayrollAdjustment(form) {
    const selectedEmployee = employeeFromForm(data.employees, form.employeeId, form.employeeName);
    const employeeName = String(selectedEmployee?.fullName || form.employeeName || '').trim();
    const amount = num(form.amount);

    if (!employeeName) {
      alert('Selecciona el empleado.');
      return false;
    }

    if (amount <= 0) {
      alert('Ingresa un monto mayor a cero.');
      return false;
    }

    const adjustment = {
      id: form.id || uid(),
      date: form.date || today(),
      employeeId: selectedEmployee?.id || '',
      employeeName,
      type: form.type || 'bono',
      amount,
      note: String(form.note || '').trim(),
      savedAt: new Date().toISOString()
    };

    await persist({ ...data, payrollAdjustments: upsert(data.payrollAdjustments || [], adjustment) });
    return true;
  }

  async function saveEmployee(form) {
    if (!ownerUnlocked) return false;

    const fullName = String(form.fullName || '').trim();
    const cedula = String(form.cedula || '').trim();
    const phone = String(form.phone || '').trim();

    if (!fullName || !cedula || !phone) {
      alert('Completa nombre, cedula y telefono del empleado.');
      return false;
    }

    const employee = {
      id: form.id || uid(),
      fullName,
      cedula,
      phone,
      savedAt: new Date().toISOString()
    };

    await persist({ ...data, employees: upsert(data.employees || [], employee) });
    return true;
  }

  async function deleteEmployee(id) {
    if (!ownerUnlocked || !confirm('Eliminar este empleado?')) return;
    await persist({ ...data, employees: (data.employees || []).filter((employee) => employee.id !== id) });
  }

  async function deletePayrollAdjustment(id) {
    if (!ownerUnlocked || !confirm('Eliminar este movimiento de sueldo?')) return;
    await persist({ ...data, payrollAdjustments: (data.payrollAdjustments || []).filter((item) => item.id !== id) });
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
          <img className="brand-logo" src={logoUrl} alt="ALMETALES" />
          <div>
            <h1>ALMETALES</h1>
            <span>Turno dia y turno noche</span>
          </div>
        </div>

        <nav className="nav" aria-label="Navegacion principal">
          <button className={activeView === 'employee' ? 'active' : ''} onClick={() => setActiveView('employee')}>Registrar turno</button>
          {ownerUnlocked && <button className={activeView === 'owner' ? 'active' : ''} onClick={() => setActiveView('owner')}>Revision dueno</button>}
          {ownerUnlocked && <button className={activeView === 'salaries' ? 'active' : ''} onClick={() => setActiveView('salaries')}>Sueldos empleados</button>}
          {ownerUnlocked && <button className={activeView === 'reports' ? 'active' : ''} onClick={() => setActiveView('reports')}>Reportes</button>}
          {ownerUnlocked && <button className={activeView === 'materials' ? 'active' : ''} onClick={() => setActiveView('materials')}>Arqueo materiales</button>}
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

        {activeView === 'salaries' && ownerUnlocked && (
          <SalariesView
            shifts={data.shifts}
            adjustments={data.payrollAdjustments}
            employees={data.employees}
            onSaveAdjustment={savePayrollAdjustment}
            onDeleteAdjustment={deletePayrollAdjustment}
          />
        )}

        {activeView === 'reports' && ownerUnlocked && (
          <ReportsView activeDate={activeDate} shifts={data.shifts} />
        )}

        {activeView === 'materials' && ownerUnlocked && (
          <MaterialsAuditView compras={comprasDiarias} />
        )}

        {activeView === 'settings' && ownerUnlocked && (
          <SettingsView
            data={data}
            onSave={saveConfig}
            onImport={importData}
            onClear={clearData}
            onSaveEmployee={saveEmployee}
            onDeleteEmployee={deleteEmployee}
          />
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
          employees={data.employees}
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
          <img className="brand-logo" src={logoUrl} alt="ALMETALES" />
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
  const expenses = movements.filter((movement) => ['gasto', 'retiro', 'vale'].includes(movement.type));
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
          <MovementBox title="Gastos y vales registrados" total={expenseTotal} status="bad" movements={expenses} emptyText="No hay gastos o vales registrados para esta caja." canDelete={deleteUnlocked} onAdd={() => onOpenMovement('gasto')} onAddVale={() => onOpenMovement('vale')} onDelete={onDeleteMovement} />
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

function MovementBox({ title, total, status, movements, emptyText, canDelete, onAdd, onAddVale, onDelete }) {
  return (
    <div className="panel span-6">
      <div className="section-title">
        <h3>{title}</h3>
        <div className="toolbar">
          <span className={`status ${status}`}>{money.format(fromCents(total))}</span>
          <button className="primary" onClick={onAdd}>Registrar</button>
          {onAddVale && <button className="secondary" onClick={onAddVale}>Vale</button>}
        </div>
      </div>
      {!movements.length ? <Empty text={emptyText} /> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Turno</th><th>Tipo</th><th>Motivo</th><th>Monto</th><th>Registra</th>{canDelete && <th>Accion</th>}</tr>
            </thead>
            <tbody>
              {movements.map((movement) => (
                <tr key={movement.id}>
                  <td>{movement.shiftName}</td>
                  <td><span className={`status mini ${movementTypeStatus(movement.type)}`}>{movementLabel(movement)}</span></td>
                  <td>{movement.beneficiaryName && <b>{movement.beneficiaryName}: </b>}{movement.reason}</td>
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
  const movements = shiftMovementEntries(shifts);
  const incomeMovements = movements.filter((movement) => movement.type === 'ingreso');
  const expenseMovements = movements.filter((movement) => movement.type !== 'ingreso');
  const incomes = incomeMovements.reduce((sum, movement) => sum + cents(movement.amount), 0);
  const expenses = expenseMovements
    .filter((movement) => movement.type === 'gasto' || movement.type === 'retiro')
    .reduce((sum, movement) => sum + cents(movement.amount), 0);
  const vales = expenseMovements
    .filter((movement) => movement.type === 'vale')
    .reduce((sum, movement) => sum + cents(movement.amount), 0);
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
      <Metric title="Vales empleados" value={money.format(fromCents(vales))} note="Adelantos de sueldo" />
      <Metric title="Efectivo dejado" value={money.format(fromCents(left))} note="Contado por denominaciones" />
      <Metric title="Diferencia neta" value={money.format(fromCents(diff))} note={shifts.length ? diffText(diff) : 'Sin cierres'} />
      <div className="panel span-12 private">
        <div className="section-title">
          <h3>Resumen de caja por turno</h3>
          <div className="toolbar no-print">
            <button className="primary" onClick={() => downloadOwnerSummaryImage({ shifts, compras, activeDate, shiftFilter })}>Imagen para jefe</button>
            <button className="secondary" onClick={() => onOpenMovement(null)}>Agregar movimiento</button>
            <button className="secondary" onClick={() => onOpenShift(null)}>Agregar cierre</button>
          </div>
        </div>
        {!shifts.length ? <Empty text="No hay cierres para revisar en esta fecha." /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Turno</th><th>Empleado</th><th>Inicial</th><th>Ingresos</th><th>Gastos</th><th>Vales</th><th>Retiros</th><th>Compras</th><th>Esperado</th><th>Dejado</th><th>Diferencia</th><th>Accion</th></tr>
              </thead>
              <tbody>
                {shifts.map((shift) => <OwnerShiftRows key={shift.id} shift={shift} onOpenShift={onOpenShift} onOpenMovement={onOpenMovement} onDeleteShift={onDeleteShift} onDeleteMovement={onDeleteMovement} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <MovementReviewTable
        title="Ingresos y ventas"
        total={incomes}
        status="ok"
        movements={incomeMovements}
        emptyText="No hay ingresos registrados para esta revision."
        onOpenMovement={onOpenMovement}
        onDeleteMovement={onDeleteMovement}
      />

      <MovementReviewTable
        title="Gastos, retiros y vales"
        total={expenses + vales}
        status="bad"
        movements={expenseMovements}
        emptyText="No hay gastos, retiros ni vales registrados para esta revision."
        onOpenMovement={onOpenMovement}
        onDeleteMovement={onDeleteMovement}
      />
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
        <td>{money.format(fromCents(totals.vale))}</td>
        <td>{money.format(fromCents(totals.retiro))}</td>
        <td>{money.format(num(shift.purchaseTotal))}</td>
        <td>{money.format(fromCents(expected))}</td>
        <td>{money.format(fromCents(left))}</td>
        <td><span className={`status ${diffClass(diff)}`}>{diffText(diff)} {money.format(Math.abs(fromCents(diff)))}</span></td>
        <td><RowActions onEdit={() => onOpenShift(shift.id)} onDelete={() => onDeleteShift(shift.id)} /></td>
      </tr>
      {num(shift.otherCashAmount) > 0 && (
        <tr className="subrow">
          <td colSpan="3">Otros efectivo</td>
          <td colSpan="6">{shift.otherCashReason || 'Sin detalle'}</td>
          <td>{money.format(num(shift.otherCashAmount))}</td>
          <td>{shift.employeeName || '-'}</td>
          <td></td>
        </tr>
      )}
      {shift.notes && <tr><td colSpan="12" className="muted">Notas: {shift.notes}</td></tr>}
    </>
  );
}

function MovementReviewTable({ title, total, status, movements, emptyText, onOpenMovement, onDeleteMovement }) {
  return (
    <div className="panel span-6">
      <div className="section-title">
        <h3>{title}</h3>
        <span className={`status ${status}`}>{money.format(fromCents(total))}</span>
      </div>
      {!movements.length ? <Empty text={emptyText} /> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Turno</th><th>Tipo</th><th>Detalle</th><th>Monto</th><th>Registra</th><th></th></tr>
            </thead>
            <tbody>
              {movements.map((movement) => (
                <tr key={movement.id}>
                  <td>{shiftShortName(movement.shiftName)}</td>
                  <td><span className={`status mini ${movementTypeStatus(movement.type)}`}>{movementLabel(movement)}</span></td>
                  <td>{movement.beneficiaryName && <b>{movement.beneficiaryName}: </b>}{movement.reason || '-'}</td>
                  <td>{money.format(num(movement.amount))}</td>
                  <td>{movement.employeeName || '-'}</td>
                  <td><RowActions onEdit={() => onOpenMovement(movement.id)} onDelete={() => onDeleteMovement(movement.shiftId, movement.id)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SalariesView({ shifts, adjustments = [], employees = [], onSaveAdjustment, onDeleteAdjustment }) {
  const [filters, setFilters] = useState(() => ({ desde: firstDayOfMonth(today()), hasta: today(), employeeName: '' }));
  const [form, setForm] = useState({ date: today(), employeeId: '', employeeName: '', type: 'bono', amount: '', note: '' });
  const [baseSalaries, setBaseSalaries] = useState({});
  const employeeChoices = useMemo(() => payrollEmployeeChoices(employees, shifts, adjustments), [employees, shifts, adjustments]);
  const vales = useMemo(() => payrollValeEntries(shifts, filters), [shifts, filters]);
  const filteredAdjustments = useMemo(() => payrollAdjustmentEntries(adjustments, filters), [adjustments, filters]);
  const summaries = useMemo(() => payrollSummaries(vales, filteredAdjustments, employeeChoices, filters), [vales, filteredAdjustments, employeeChoices, filters]);
  const totals = summaries.reduce((acc, row) => ({
    base: acc.base + cents(baseSalaries[row.employeeName]),
    vales: acc.vales + row.vales,
    additions: acc.additions + row.additions,
    deductions: acc.deductions + row.deductions,
    net: acc.net + row.net,
    totalPay: acc.totalPay + cents(baseSalaries[row.employeeName]) + row.net
  }), { base: 0, vales: 0, additions: 0, deductions: 0, net: 0, totalPay: 0 });

  function setFilter(field, value) {
    setFilters((current) => ({ ...current, [field]: value }));
  }

  function setField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function selectFormEmployee(employeeId) {
    const employee = findEmployeeById(employeeChoices, employeeId);
    setForm((current) => ({ ...current, employeeId, employeeName: employee?.fullName || '' }));
  }

  function setBaseSalary(employeeName, value) {
    setBaseSalaries((current) => ({ ...current, [employeeName]: value }));
  }

  function generateRole(row) {
    const rowVales = vales.filter((vale) => normalizeText(vale.employeeName) === normalizeText(row.employeeName));
    const rowAdjustments = filteredAdjustments.filter((item) => normalizeText(item.employeeName) === normalizeText(row.employeeName));
    generatePayrollRole(row, filters, baseSalaries[row.employeeName], rowVales, rowAdjustments);
  }

  async function submitAdjustment(event) {
    event.preventDefault();
    const saved = await onSaveAdjustment(form);
    if (saved) setForm((current) => ({ ...current, amount: '', note: '' }));
  }

  return (
    <section className="grid salaries-view">
      <div className="panel span-12 private">
        <div className="section-title"><h3>Filtros de sueldo</h3></div>
        <div className="form-grid">
          <label className="span-field-3">Desde<input type="date" value={filters.desde} onChange={(event) => setFilter('desde', event.target.value)} /></label>
          <label className="span-field-3">Hasta<input type="date" value={filters.hasta} onChange={(event) => setFilter('hasta', event.target.value)} /></label>
          <label className="span-field-3">Empleado
            <select value={filters.employeeName} onChange={(event) => setFilter('employeeName', event.target.value)}>
              <option value="">Todos</option>
              {employeeChoices.map((employee) => <option key={employee.id} value={employee.fullName}>{employee.fullName}</option>)}
            </select>
          </label>
          <div className="span-field-3 filter-summary">
            <span className="status info">{dateText(filters.desde)} a {dateText(filters.hasta)}</span>
          </div>
        </div>
      </div>

      <Metric title="Vales del periodo" value={money.format(fromCents(totals.vales))} note="Se descuentan del pago" />
      <Metric title="Bonos y extras" value={money.format(fromCents(totals.additions))} note="A favor del empleado" />
      <Metric title="Otros descuentos" value={money.format(fromCents(totals.deductions))} note="Adicionales al vale" />
      <Metric title="Total a pagar" value={money.format(fromCents(totals.totalPay))} note="Sueldo base mas ajustes" />

      <div className="panel span-12">
        <div className="section-title"><h3>Agregar bono, extra o descuento</h3></div>
        <form className="form-grid" onSubmit={submitAdjustment}>
          <label className="span-field-2">Fecha<input type="date" value={form.date} onChange={(event) => setField('date', event.target.value)} required /></label>
          <label className="span-field-3">Empleado
            <select value={form.employeeId} onChange={(event) => selectFormEmployee(event.target.value)} required>
              <option value="">Selecciona empleado</option>
              {employeeChoices.map((employee) => <option key={employee.id} value={employee.id}>{employee.fullName}</option>)}
            </select>
          </label>
          <label className="span-field-2">Tipo
            <select value={form.type} onChange={(event) => setField('type', event.target.value)} required>
              {payrollAdjustmentTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
            </select>
          </label>
          <label className="span-field-2">Monto<input type="number" inputMode="decimal" min="0" step="0.01" value={numberInputValue(form.amount)} onChange={(event) => setField('amount', event.target.value)} required /></label>
          <label className="span-field-3">Detalle<input value={form.note} onChange={(event) => setField('note', event.target.value)} placeholder="Ej: bono puntualidad" /></label>
          <div className="span-field-12 report-actions"><button className="primary">Guardar ajuste</button></div>
        </form>
      </div>

      <div className="panel span-12">
        <div className="section-title">
          <h3>Resumen por empleado</h3>
          <span className="status info">{summaries.length} empleado(s)</span>
        </div>
        {!summaries.length ? <Empty text="No hay vales ni ajustes en este rango." /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Empleado</th><th>Sueldo base</th><th>Vales</th><th>Bonos / extras</th><th>Descuentos</th><th>Total</th><th></th></tr>
              </thead>
              <tbody>
                {summaries.map((row) => (
                  <tr key={row.employeeName}>
                    <td><b>{row.employeeName}</b><br /><small>{row.employee?.cedula ? `Cedula ${row.employee.cedula}` : 'Sin cedula registrada'}</small></td>
                    <td><input className="table-input" type="number" inputMode="decimal" min="0" step="0.01" value={numberInputValue(baseSalaries[row.employeeName])} onChange={(event) => setBaseSalary(row.employeeName, event.target.value)} placeholder="0.00" /></td>
                    <td>{money.format(fromCents(row.vales))}</td>
                    <td>{money.format(fromCents(row.additions))}</td>
                    <td>{money.format(fromCents(row.deductions))}</td>
                    <td><span className={`status ${cents(baseSalaries[row.employeeName]) + row.net < 0 ? 'bad' : 'ok'}`}>{money.format(fromCents(cents(baseSalaries[row.employeeName]) + row.net))}</span></td>
                    <td><button className="secondary" type="button" onClick={() => generateRole(row)}>Generar Rol De Pago</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel span-6">
        <div className="section-title"><h3>Vales registrados</h3><span className="status warn">{money.format(fromCents(totals.vales))}</span></div>
        {!vales.length ? <Empty text="No hay vales registrados en este rango." /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Fecha</th><th>Empleado</th><th>Motivo</th><th>Monto</th></tr></thead>
              <tbody>
                {vales.map((vale) => (
                  <tr key={vale.id}>
                    <td>{vale.date} {shiftShortName(vale.shiftName)}</td>
                    <td>{vale.employeeName}</td>
                    <td>{vale.reason || 'Vale empleado'}</td>
                    <td>{money.format(num(vale.amount))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel span-6">
        <div className="section-title"><h3>Bonos, extras y descuentos</h3></div>
        {!filteredAdjustments.length ? <Empty text="No hay ajustes manuales en este rango." /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Fecha</th><th>Empleado</th><th>Tipo</th><th>Monto</th><th></th></tr></thead>
              <tbody>
                {filteredAdjustments.map((item) => (
                  <tr key={item.id}>
                    <td>{item.date}</td>
                    <td>{item.employeeName}</td>
                    <td><span className={`status mini ${payrollAdjustmentMeta(item.type).sign > 0 ? 'ok' : 'bad'}`}>{payrollAdjustmentMeta(item.type).label}</span> {item.note}</td>
                    <td>{money.format(num(item.amount))}</td>
                    <td><button className="icon-btn" title="Eliminar" onClick={() => onDeleteAdjustment(item.id)}>x</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function ReportsView({ activeDate, shifts = [] }) {
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

      <SalesReportPanel shifts={shifts} activeDate={activeDate} />
    </section>
  );
}

function SalesReportPanel({ shifts, activeDate }) {
  const [filters, setFilters] = useState(() => ({ desde: firstDayOfMonth(activeDate), hasta: activeDate }));
  const sales = useMemo(() => salesEntries(shifts, filters), [shifts, filters]);
  const total = sales.reduce((sum, sale) => sum + cents(sale.amount), 0);
  const byDay = groupSalesByDay(sales);

  useEffect(() => {
    setFilters((current) => current.desde || current.hasta ? current : { desde: firstDayOfMonth(activeDate), hasta: activeDate });
  }, [activeDate]);

  function setFilter(field, value) {
    setFilters((current) => ({ ...current, [field]: value }));
  }

  return (
    <div className="panel span-12 sales-report">
      <div className="section-title">
        <h3>Ventas de patio</h3>
        <span className="status ok">{money.format(fromCents(total))}</span>
      </div>
      <div className="form-grid">
        <label className="span-field-3">Desde<input type="date" value={filters.desde} onChange={(event) => setFilter('desde', event.target.value)} /></label>
        <label className="span-field-3">Hasta<input type="date" value={filters.hasta} onChange={(event) => setFilter('hasta', event.target.value)} /></label>
        <div className="span-field-6 filter-summary"><span className="status info">{sales.length} venta(s)</span></div>
      </div>

      {!sales.length ? <Empty text="No hay ventas registradas en este rango." /> : (
        <div className="sales-grid">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Dia</th><th>Total ventas</th><th>Registros</th></tr></thead>
              <tbody>
                {byDay.map((row) => (
                  <tr key={row.date}>
                    <td>{row.date}</td>
                    <td>{money.format(fromCents(row.total))}</td>
                    <td>{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Fecha</th><th>Turno</th><th>Detalle</th><th>Monto</th></tr></thead>
              <tbody>
                {sales.map((sale) => (
                  <tr key={sale.id}>
                    <td>{sale.date}</td>
                    <td>{shiftShortName(sale.shiftName)}</td>
                    <td>{sale.reason || 'Venta de patio'}</td>
                    <td>{money.format(num(sale.amount))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function MaterialsAuditView({ compras }) {
  const materialOptions = useMemo(() => materialOptionsFromCompras(compras), [compras]);
  const [rows, setRows] = useState(() => [newMaterialAuditRow()]);
  const calculatedRows = rows.map(calculateMaterialAuditRow);
  const totals = calculatedRows.reduce((acc, row) => ({
    expected: acc.expected + row.expected,
    reported: acc.reported + row.reported,
    diff: acc.diff + row.diff
  }), { expected: 0, reported: 0, diff: 0 });

  function updateRow(id, field, value) {
    setRows((current) => current.map((row) => row.id === id ? { ...row, [field]: value } : row));
  }

  function addRow() {
    setRows((current) => [...current, newMaterialAuditRow()]);
  }

  function removeRow(id) {
    setRows((current) => current.length === 1 ? current : current.filter((row) => row.id !== id));
  }

  function clearRows() {
    setRows([newMaterialAuditRow()]);
  }

  return (
    <section className="grid materials-audit">
      <Metric title="Teorico" value={`${roundWeight(totals.expected).toLocaleString('es-CO')}`} note="Peso esperado segun formula" />
      <Metric title="Recolector" value={`${roundWeight(totals.reported).toLocaleString('es-CO')}`} note="Peso reportado" />
      <Metric title="Diferencia" value={`${roundWeight(totals.diff).toLocaleString('es-CO')}`} note={materialDiffNote(totals.diff)} />
      <Metric title="Materiales" value={rows.length} note="Filas del arqueo" />

      <div className="panel span-12">
        <div className="section-title">
          <h3>Arqueo por material</h3>
          <div className="toolbar">
            <button className="secondary" type="button" onClick={clearRows}>Limpiar</button>
            <button className="primary" type="button" onClick={addRow}>Agregar material</button>
          </div>
        </div>
        <datalist id="material-options">
          {materialOptions.map((material) => <option key={material} value={material} />)}
        </datalist>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Material</th><th>Tipo</th><th>Inventario sistema</th><th>Recuperado</th><th>Reporte recolector</th><th>Teorico</th><th>Diferencia</th><th></th></tr>
            </thead>
            <tbody>
              {calculatedRows.map((row) => (
                <tr key={row.id}>
                  <td><input value={row.material} list="material-options" onChange={(event) => updateRow(row.id, 'material', event.target.value)} placeholder="Material" /></td>
                  <td>
                    <select value={row.materialType} onChange={(event) => updateRow(row.id, 'materialType', event.target.value)}>
                      {materialAuditTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                    </select>
                  </td>
                  <td><input type="number" inputMode="decimal" min="0" step="0.001" value={numberInputValue(row.inventoryWeight)} onChange={(event) => updateRow(row.id, 'inventoryWeight', event.target.value)} placeholder="kg" /></td>
                  <td><input type="number" inputMode="decimal" min="0" step="0.001" value={numberInputValue(row.recoveredWeight)} onChange={(event) => updateRow(row.id, 'recoveredWeight', event.target.value)} placeholder="kg" /></td>
                  <td><input type="number" inputMode="decimal" min="0" step="0.001" value={numberInputValue(row.reportedWeight)} onChange={(event) => updateRow(row.id, 'reportedWeight', event.target.value)} placeholder={materialAuditUnit(row.materialType)} /></td>
                  <td><b>{roundWeight(row.expected).toLocaleString('es-CO')} {materialAuditUnit(row.materialType)}</b></td>
                  <td><span className={`status ${materialDiffClass(row.diff)}`}>{roundWeight(row.diff).toLocaleString('es-CO')} {materialAuditUnit(row.materialType)}</span></td>
                  <td><button className="icon-btn" type="button" title="Eliminar" onClick={() => removeRow(row.id)}>x</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint">Metales no ferrosos: (inventario kg + recuperado kg) x 2.2 x 1.10. Otros materiales: (inventario + recuperado) x 1.10.</p>
      </div>
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

function SettingsView({ data, onSave, onImport, onClear, onSaveEmployee, onDeleteEmployee }) {
  const [ownerPin, setOwnerPin] = useState(data.ownerPin);
  const [employeePin, setEmployeePin] = useState(data.employeePin);
  const [employeeForm, setEmployeeForm] = useState(emptyEmployeeForm());

  function setEmployeeField(field, value) {
    setEmployeeForm((current) => ({ ...current, [field]: value }));
  }

  async function submitEmployee(event) {
    event.preventDefault();
    const saved = await onSaveEmployee(employeeForm);
    if (saved) setEmployeeForm(emptyEmployeeForm());
  }

  function editEmployee(employee) {
    setEmployeeForm({
      id: employee.id,
      fullName: employee.fullName,
      cedula: employee.cedula,
      phone: employee.phone
    });
  }

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
      <div className="panel span-12">
        <div className="section-title"><h3>Empleados</h3><span className="status info">{(data.employees || []).length} registrados</span></div>
        <form className="form-grid" onSubmit={submitEmployee}>
          <label className="span-field-4">Nombre completo
            <input value={employeeForm.fullName} onChange={(event) => setEmployeeField('fullName', event.target.value)} placeholder="Nombre y apellido" required />
          </label>
          <label className="span-field-4">Numero de cedula
            <input value={employeeForm.cedula} onChange={(event) => setEmployeeField('cedula', event.target.value)} placeholder="Cedula" required />
          </label>
          <label className="span-field-4">Telefono
            <input value={employeeForm.phone} onChange={(event) => setEmployeeField('phone', event.target.value)} placeholder="Telefono" required />
          </label>
          <div className="span-field-12 report-actions">
            <button className="primary">{employeeForm.id ? 'Actualizar empleado' : 'Registrar empleado'}</button>
            {employeeForm.id && <button type="button" className="secondary" onClick={() => setEmployeeForm(emptyEmployeeForm())}>Cancelar edicion</button>}
          </div>
        </form>

        {(data.employees || []).length > 0 && (
          <div className="table-wrap settings-table">
            <table>
              <thead><tr><th>Empleado</th><th>Cedula</th><th>Telefono</th><th></th></tr></thead>
              <tbody>
                {data.employees.map((employee) => (
                  <tr key={employee.id}>
                    <td><b>{employee.fullName}</b></td>
                    <td>{employee.cedula}</td>
                    <td>{employee.phone}</td>
                    <td><RowActions onEdit={() => editEmployee(employee)} onDelete={() => onDeleteEmployee(employee.id)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
    if ((!ownerUnlocked || !form.id) && syncedPurchases > 0) next.purchaseTotal = syncedPurchases;
    if (next.openingCash !== form.openingCash || next.purchaseTotal !== form.purchaseTotal) onChange(next);
  }, [form.date, form.shiftName, syncedPurchases, ownerUnlocked]);

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
          <label className="span-field-4">Total compras reciclaje<input type="number" inputMode="decimal" min="0" step="0.01" value={numberInputValue(form.purchaseTotal)} readOnly={!ownerUnlocked} onChange={(event) => setField('purchaseTotal', event.target.value)} required /><small>{syncedPurchases > 0 ? `Sincronizado para este turno: ${money.format(syncedPurchases)}.` : 'Sin compras sincronizadas para este turno.'}</small></label>
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

function MovementModal({ form, employees = [], onClose, onChange, onSubmit }) {
  const selectedBeneficiaryId = form.beneficiaryId || employeeIdByName(employees, form.beneficiaryName);
  const legacyBeneficiaryValue = form.beneficiaryName && !selectedBeneficiaryId ? `legacy:${form.beneficiaryName}` : '';

  function setField(field, value) {
    onChange({ ...form, [field]: value });
  }

  function setBeneficiary(value) {
    if (value.startsWith('legacy:')) {
      onChange({ ...form, beneficiaryId: '', beneficiaryName: value.replace('legacy:', '') });
      return;
    }

    const employee = findEmployeeById(employees, value);
    onChange({ ...form, beneficiaryId: value, beneficiaryName: employee?.fullName || '' });
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
          {form.type === 'ingreso' ? (
            <label className="span-field-3">Tipo de ingreso
              <select value={form.incomeType || 'general'} onChange={(event) => setField('incomeType', event.target.value)} required>
                {incomeTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
              </select>
            </label>
          ) : form.type === 'vale' ? (
            <label className="span-field-3">Tipo<input value="Vale / adelanto" readOnly /></label>
          ) : (
            <label className="span-field-3">Tipo
              <select value={form.type} onChange={(event) => setField('type', event.target.value)} required>
                {expenseTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
              </select>
            </label>
          )}
          <label className="span-field-3">Monto<input type="number" inputMode="decimal" min="0" step="0.01" value={numberInputValue(form.amount)} onChange={(event) => setField('amount', event.target.value)} required /></label>
          <label className="span-field-4">Registrado por<input value={form.employeeName} onChange={(event) => setField('employeeName', event.target.value)} placeholder="Nombre" /></label>
          {form.type === 'vale' && (
            <label className="span-field-4">Empleado que recibe el vale
              <select value={selectedBeneficiaryId || legacyBeneficiaryValue} onChange={(event) => setBeneficiary(event.target.value)} required>
                <option value="">Selecciona empleado</option>
                {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.fullName}</option>)}
                {legacyBeneficiaryValue && <option value={legacyBeneficiaryValue}>{form.beneficiaryName}</option>}
              </select>
              {!employees.length && <small>Primero registra empleados en Configuracion.</small>}
            </label>
          )}
          <label className={form.type === 'vale' ? 'span-field-8' : 'span-field-8'}>Motivo<input value={form.reason} onChange={(event) => setField('reason', event.target.value)} placeholder={form.type === 'vale' ? 'Ej: adelanto de sueldo' : form.incomeType === 'ventas' ? 'Ej: venta de patio' : 'Ej: almuerzos, transporte, ajuste'} required={form.type !== 'vale'} /></label>
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
    shifts: Array.isArray(value?.shifts) ? value.shifts : [],
    payrollAdjustments: Array.isArray(value?.payrollAdjustments) ? value.payrollAdjustments : [],
    employees: Array.isArray(value?.employees) ? value.employees.map(normalizeEmployee).filter((employee) => employee.fullName) : []
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
    incomeType: movement?.incomeType || 'general',
    amount: movement?.amount ?? '',
    employeeName: movement?.employeeName || fallbackName || '',
    beneficiaryId: movement?.beneficiaryId || '',
    beneficiaryName: movement?.beneficiaryName || '',
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
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value ?? '').trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
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

function roundWeight(value) {
  return Math.round(num(value) * 1000) / 1000;
}

function cashLeft(denoms, otherCashAmount = 0) {
  return Object.entries(denoms || {}).reduce((sum, [denom, count]) => sum + cents(denom) * num(count), cents(otherCashAmount));
}

function shiftCashLeft(shift) {
  return cashLeft(shift?.denoms, shift?.otherCashAmount);
}

function movementTotals(shift) {
  const totals = { ingreso: cents(shift.otherIncome), gasto: cents(shift.expenseTotal), retiro: cents(shift.ownerWithdrawals), vale: 0 };
  (shift.movements || []).forEach((movement) => {
    totals[movement.type] = (totals[movement.type] || 0) + cents(movement.amount);
  });
  return totals;
}

function expectedLeft(shift) {
  const totals = movementTotals(shift);
  return cents(shift.openingCash) + totals.ingreso - cents(shift.purchaseTotal) - totals.gasto - totals.retiro - totals.vale;
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

function nextDate(date) {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + 1);
  return value.toISOString().slice(0, 10);
}

function previousShift(shifts, date, shiftName) {
  if (shiftName === 'Turno noche') return findShift(shifts, date, 'Turno dia');
  return findShift(shifts, previousDate(date), 'Turno noche');
}

function autoOpeningCash(shifts, date, shiftName) {
  return fromCents(shiftCashLeft(previousShift(shifts, date, shiftName)));
}

function nextShiftKey(date, shiftName) {
  if (shiftName === 'Turno dia') return { date, shiftName: 'Turno noche' };
  return { date: nextDate(date), shiftName: 'Turno dia' };
}

function cascadeOpeningCash(shifts, changedShift) {
  const nextKey = nextShiftKey(changedShift.date, changedShift.shiftName);
  const next = findShift(shifts, nextKey.date, nextKey.shiftName);
  if (!next) return shifts;

  const openingCash = fromCents(shiftCashLeft(changedShift));
  if (Math.abs(num(next.openingCash) - openingCash) < 0.005) return shifts;
  return upsert(shifts, { ...next, openingCash, savedAt: new Date().toISOString() });
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

function movementLabel(movement) {
  return movementTypeLabel(movement.type, movement.incomeType);
}

function movementTypeLabel(type, incomeType = 'general') {
  if (type === 'ingreso') return incomeType === 'ventas' ? 'Ventas' : 'Ingreso';
  if (type === 'retiro') return 'Retiro';
  if (type === 'vale') return 'Vale';
  return 'Gasto';
}

function movementTypeStatus(type) {
  if (type === 'ingreso') return 'ok';
  if (type === 'retiro' || type === 'vale') return 'warn';
  return 'bad';
}

function firstDayOfMonth(date) {
  return `${date.slice(0, 7)}-01`;
}

function dateInRange(date, desde, hasta) {
  if (!date) return false;
  if (desde && date < desde) return false;
  if (hasta && date > hasta) return false;
  return true;
}

function shiftMovementEntries(shifts = []) {
  return shifts.flatMap((shift) => (shift.movements || []).map((movement) => ({
    ...movement,
    date: shift.date,
    shiftName: shift.shiftName,
    shiftId: shift.id
  })));
}

function salesEntries(shifts = [], filters = {}) {
  return shiftMovementEntries(shifts)
    .filter((movement) => movement.type === 'ingreso' && movement.incomeType === 'ventas')
    .filter((movement) => dateInRange(movement.date, filters.desde, filters.hasta))
    .sort((a, b) => a.date.localeCompare(b.date) || a.shiftName.localeCompare(b.shiftName));
}

function groupSalesByDay(sales = []) {
  const rows = new Map();
  sales.forEach((sale) => {
    const current = rows.get(sale.date) || { date: sale.date, total: 0, count: 0 };
    current.total += cents(sale.amount);
    current.count += 1;
    rows.set(sale.date, current);
  });
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function materialOptionsFromCompras(compras = defaultCompras) {
  const fromOptions = compras?.opciones?.materiales || [];
  const fromEntries = (compras?.compras || []).map((compra) => compra.material);
  return sortedUnique([...fromOptions, ...fromEntries]);
}

function newMaterialAuditRow() {
  return {
    id: uid(),
    material: '',
    materialType: 'nonFerrous',
    inventoryWeight: '',
    recoveredWeight: '',
    reportedWeight: ''
  };
}

function calculateMaterialAuditRow(row) {
  const base = num(row.inventoryWeight) + num(row.recoveredWeight);
  const converted = row.materialType === 'nonFerrous' ? base * 2.2 : base;
  const expected = converted * 1.10;
  const reported = num(row.reportedWeight);
  return {
    ...row,
    expected,
    reported,
    diff: reported - expected
  };
}

function materialAuditUnit(materialType) {
  return materialAuditTypes.find((type) => type.value === materialType)?.reportUnit || 'kg';
}

function materialDiffClass(diff) {
  if (Math.abs(diff) < 1) return 'ok';
  return diff > 0 ? 'warn' : 'bad';
}

function materialDiffNote(diff) {
  if (Math.abs(diff) < 1) return 'Cuadra';
  return diff > 0 ? 'Sobra peso' : 'Falta peso';
}

function downloadOwnerSummaryImage({ shifts = [], compras = defaultCompras, activeDate, shiftFilter }) {
  const movements = shiftMovementEntries(shifts);
  const incomeMovements = movements.filter((movement) => movement.type === 'ingreso');
  const expenseMovements = movements.filter((movement) => movement.type !== 'ingreso');
  const width = 1200;
  const height = Math.max(900, 620 + (shifts.length * 90) + (movements.length * 34));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const purchases = compras.cantidadRegistros
    ? cents(shiftFilter ? purchaseTotalForShift(compras, shiftFilter) : num(compras.totalDiario))
    : shifts.reduce((sum, shift) => sum + cents(shift.purchaseTotal), 0);
  const incomes = incomeMovements.reduce((sum, movement) => sum + cents(movement.amount), 0);
  const expenses = expenseMovements.filter((movement) => movement.type === 'gasto' || movement.type === 'retiro').reduce((sum, movement) => sum + cents(movement.amount), 0);
  const vales = expenseMovements.filter((movement) => movement.type === 'vale').reduce((sum, movement) => sum + cents(movement.amount), 0);
  const left = shifts.reduce((sum, shift) => sum + shiftCashLeft(shift), 0);
  const diff = shifts.reduce((sum, shift) => sum + shiftDiff(shift), 0);

  ctx.fillStyle = '#f5f8f6';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#173324';
  ctx.fillRect(0, 0, width, 130);
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 42px Arial';
  ctx.fillText(companyInfo.name, 44, 58);
  ctx.font = '700 24px Arial';
  ctx.fillText('Cuadre de caja', 44, 96);
  ctx.font = '18px Arial';
  ctx.fillText(`${activeDate} - ${shiftFilter ? shiftShortName(shiftFilter) : 'Dia completo'}`, 850, 58);
  ctx.fillText(`Generado ${dateText(new Date().toISOString())}`, 850, 92);

  const cards = [
    ['Compras', purchases],
    ['Ingresos', incomes],
    ['Gastos/retiros', expenses],
    ['Vales', vales],
    ['Efectivo dejado', left],
    [diffText(diff), Math.abs(diff)]
  ];
  let y = 164;
  cards.forEach((card, index) => {
    const x = 44 + (index % 3) * 370;
    const cardY = y + Math.floor(index / 3) * 112;
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, x, cardY, 330, 84, 10);
    ctx.fill();
    ctx.fillStyle = '#66746c';
    ctx.font = '700 16px Arial';
    ctx.fillText(card[0], x + 18, cardY + 28);
    ctx.fillStyle = index === 5 && diff < -99 ? '#a92b22' : '#173324';
    ctx.font = '700 30px Arial';
    ctx.fillText(money.format(fromCents(card[1])), x + 18, cardY + 66);
  });

  y += 250;
  ctx.fillStyle = '#16201a';
  ctx.font = '700 24px Arial';
  ctx.fillText('Turnos', 44, y);
  y += 28;
  shifts.forEach((shift) => {
    const totals = movementTotals(shift);
    const expected = expectedLeft(shift);
    const cash = shiftCashLeft(shift);
    const shiftDifference = shiftDiff(shift);
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, 44, y, 1112, 72, 8);
    ctx.fill();
    ctx.fillStyle = '#16201a';
    ctx.font = '700 18px Arial';
    ctx.fillText(`${shiftShortName(shift.shiftName)} - ${shift.employeeName || 'Sin empleado'}`, 62, y + 26);
    ctx.font = '15px Arial';
    ctx.fillStyle = '#66746c';
    ctx.fillText(`Inicial ${money.format(num(shift.openingCash))} | Compras ${money.format(num(shift.purchaseTotal))} | Ingresos ${money.format(fromCents(totals.ingreso))} | Salidas ${money.format(fromCents(totals.gasto + totals.retiro + totals.vale))}`, 62, y + 50);
    ctx.fillStyle = diffClass(shiftDifference) === 'bad' ? '#a92b22' : '#206b46';
    ctx.font = '700 17px Arial';
    ctx.fillText(`Esperado ${money.format(fromCents(expected))} | Dejado ${money.format(fromCents(cash))} | ${diffText(shiftDifference)} ${money.format(Math.abs(fromCents(shiftDifference)))}`, 690, y + 38);
    y += 88;
  });

  y += 14;
  y = drawMovementGroup(ctx, 'Ingresos y ventas', incomeMovements, y);
  y = drawMovementGroup(ctx, 'Gastos, retiros y vales', expenseMovements, y + 22);

  const link = document.createElement('a');
  link.href = canvas.toDataURL('image/png');
  link.download = `cuadre-caja-${activeDate}-${shiftFilter ? shiftShortName(shiftFilter).toLowerCase() : 'dia-completo'}.png`;
  link.click();
}

function drawMovementGroup(ctx, title, movements, y) {
  ctx.fillStyle = '#16201a';
  ctx.font = '700 24px Arial';
  ctx.fillText(title, 44, y);
  y += 30;

  if (!movements.length) {
    ctx.fillStyle = '#66746c';
    ctx.font = '16px Arial';
    ctx.fillText('Sin registros.', 62, y + 18);
    return y + 42;
  }

  movements.forEach((movement) => {
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, 44, y, 1112, 28, 6);
    ctx.fill();
    ctx.fillStyle = '#16201a';
    ctx.font = '15px Arial';
    ctx.fillText(`${shiftShortName(movement.shiftName)} | ${movementLabel(movement)} | ${movement.beneficiaryName ? `${movement.beneficiaryName}: ` : ''}${movement.reason || '-'}`, 60, y + 19);
    ctx.font = '700 15px Arial';
    ctx.fillText(money.format(num(movement.amount)), 1040, y + 19);
    y += 34;
  });
  return y;
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function payrollEmployeeChoices(employees = [], shifts = [], adjustments = []) {
  const registered = employees.map(normalizeEmployee).filter((employee) => employee.fullName);
  const registeredNames = new Set(registered.map((employee) => normalizeText(employee.fullName)));
  const historicNames = sortedUnique([
    ...payrollValeEntries(shifts, {}).map((vale) => vale.employeeName),
    ...adjustments.map((item) => item.employeeName)
  ].filter(Boolean));
  const historic = historicNames
    .filter((name) => !registeredNames.has(normalizeText(name)))
    .map((name, index) => ({
      id: employeeKey({ fullName: name }, index),
      fullName: name,
      cedula: '',
      phone: ''
    }));

  return [...registered, ...historic].sort((a, b) => a.fullName.localeCompare(b.fullName));
}

function payrollValeEntries(shifts = [], filters = {}) {
  return shifts.flatMap((shift) => (shift.movements || [])
    .filter((movement) => movement.type === 'vale')
    .map((movement) => ({
      id: movement.id,
      date: shift.date,
      shiftName: shift.shiftName,
      amount: num(movement.amount),
      employeeName: cleanEmployeeName(movement.beneficiaryName || movement.reason || movement.employeeName),
      reason: movement.reason,
      registeredBy: movement.employeeName
    })))
    .filter((vale) => dateInRange(vale.date, filters.desde, filters.hasta))
    .filter((vale) => !filters.employeeName || normalizeText(vale.employeeName) === normalizeText(filters.employeeName))
    .sort((a, b) => a.date.localeCompare(b.date) || a.employeeName.localeCompare(b.employeeName));
}

function payrollAdjustmentEntries(adjustments = [], filters = {}) {
  return adjustments
    .filter((item) => dateInRange(item.date, filters.desde, filters.hasta))
    .filter((item) => !filters.employeeName || normalizeText(item.employeeName) === normalizeText(filters.employeeName))
    .sort((a, b) => a.date.localeCompare(b.date) || a.employeeName.localeCompare(b.employeeName));
}

function payrollSummaries(vales = [], adjustments = [], employees = [], filters = {}) {
  const rows = new Map();

  function rowFor(employeeName, employee = null) {
    const cleanName = cleanEmployeeName(employeeName);
    if (!rows.has(cleanName)) rows.set(cleanName, { employeeName: cleanName, employee, vales: 0, additions: 0, deductions: 0, net: 0 });
    if (employee && !rows.get(cleanName).employee) rows.get(cleanName).employee = employee;
    return rows.get(cleanName);
  }

  employees
    .filter((employee) => !filters.employeeName || normalizeText(employee.fullName) === normalizeText(filters.employeeName))
    .forEach((employee) => rowFor(employee.fullName, employee));

  vales.forEach((vale) => {
    const row = rowFor(vale.employeeName, findEmployeeByName(employees, vale.employeeName));
    row.vales += cents(vale.amount);
  });

  adjustments.forEach((item) => {
    const row = rowFor(item.employeeName, findEmployeeByName(employees, item.employeeName));
    const amount = cents(item.amount);
    if (payrollAdjustmentMeta(item.type).sign > 0) row.additions += amount;
    else row.deductions += amount;
  });

  return [...rows.values()]
    .map((row) => ({ ...row, net: row.additions - row.deductions - row.vales }))
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName));
}

function payrollAdjustmentMeta(type) {
  return payrollAdjustmentTypes.find((item) => item.value === type) || payrollAdjustmentTypes[0];
}

function payrollNetNote(value) {
  if (value < 0) return 'A descontar del pago';
  if (value > 0) return 'A sumar al pago';
  return 'Sin impacto neto';
}

function cleanEmployeeName(value) {
  return String(value || '').trim() || 'Sin empleado';
}

function emptyEmployeeForm() {
  return { id: '', fullName: '', cedula: '', phone: '' };
}

function normalizeEmployee(employee, index = 0) {
  const fullName = String(employee?.fullName || employee?.name || employee?.employeeName || '').trim();
  const cedula = String(employee?.cedula || employee?.document || '').trim();
  const phone = String(employee?.phone || employee?.telefono || '').trim();
  return {
    id: employee?.id || employeeKey({ fullName, cedula, phone }, index),
    fullName,
    cedula,
    phone,
    savedAt: employee?.savedAt || ''
  };
}

function employeeKey(employee, index = 0) {
  const name = normalizeText(employee?.fullName).replace(/\s+/g, '-');
  const cedula = String(employee?.cedula || '').replace(/\D/g, '');
  return `employee-${cedula || name || index}`;
}

function findEmployeeById(employees = [], id) {
  return employees.map(normalizeEmployee).find((employee) => employee.id === id) || null;
}

function findEmployeeByName(employees = [], name) {
  return employees.map(normalizeEmployee).find((employee) => normalizeText(employee.fullName) === normalizeText(name)) || null;
}

function employeeIdByName(employees = [], name) {
  return findEmployeeByName(employees, name)?.id || '';
}

function employeeFromForm(employees = [], id, name) {
  if (id) return findEmployeeById(employees, id) || { id, fullName: String(name || '').trim(), cedula: '', phone: '' };
  const byName = findEmployeeByName(employees, name);
  return byName || { id: '', fullName: String(name || '').trim(), cedula: '', phone: '' };
}

function generatePayrollRole(row, filters, baseSalary, vales = [], adjustments = []) {
  const base = cents(baseSalary);
  const total = base + row.net;
  const employee = row.employee || { fullName: row.employeeName, cedula: '', phone: '' };
  const additions = adjustments.filter((item) => payrollAdjustmentMeta(item.type).sign > 0);
  const deductions = adjustments.filter((item) => payrollAdjustmentMeta(item.type).sign < 0);
  const payrollWindow = window.open('', '_blank');
  const logoSrc = absoluteAssetUrl(logoUrl);

  if (!payrollWindow) {
    alert('El navegador bloqueo la ventana del rol de pago.');
    return;
  }

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Rol de pago - ${escapeHtml(employee.fullName)}</title>
  <style>
    body { margin: 0; padding: 32px; font-family: Arial, sans-serif; color: #1f2a24; background: #f4f7f5; }
    .sheet { max-width: 820px; margin: 0 auto; background: #fff; border: 1px solid #d8e1dc; padding: 28px; }
    .head { display: flex; justify-content: space-between; gap: 20px; border-bottom: 3px solid #173324; padding-bottom: 18px; }
    .logo { width: 116px; height: 76px; border: 2px solid #173324; display: grid; place-items: center; background: #fff; padding: 6px; }
    .logo img { max-width: 100%; max-height: 100%; object-fit: contain; }
    h1, h2, p { margin: 0; }
    h1 { font-size: 26px; }
    h2 { margin-top: 24px; font-size: 18px; }
    .muted { color: #65736b; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 22px; margin-top: 18px; }
    table { width: 100%; border-collapse: collapse; margin-top: 14px; }
    th, td { text-align: left; border-bottom: 1px solid #d8e1dc; padding: 10px; }
    th { background: #f5f8f6; color: #65736b; font-size: 12px; text-transform: uppercase; }
    .total { margin-top: 20px; padding: 16px; background: #e2f2e8; display: flex; justify-content: space-between; font-size: 20px; font-weight: 900; }
    .sign { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; margin-top: 70px; }
    .line { border-top: 1px solid #1f2a24; padding-top: 8px; text-align: center; }
    .actions { margin: 18px auto; max-width: 820px; text-align: right; }
    button { background: #206b46; color: #fff; border: 0; padding: 10px 14px; border-radius: 8px; font-weight: 800; cursor: pointer; }
    @media print { body { background: #fff; padding: 0; } .sheet { border: 0; } .actions { display: none; } }
  </style>
</head>
<body>
  <div class="actions"><button onclick="window.print()">Imprimir / guardar PDF</button></div>
  <main class="sheet">
    <section class="head">
      <div>
        <h1>Rol de pago</h1>
        <p class="muted">${escapeHtml(filters.desde)} a ${escapeHtml(filters.hasta)}</p>
      </div>
      <div class="logo"><img src="${escapeHtml(logoSrc)}" alt="${escapeHtml(companyInfo.name)}" /></div>
      <div>
        <p><b>Empresa:</b> ${escapeHtml(companyInfo.name)}</p>
        <p><b>RUC:</b> ${escapeHtml(companyInfo.ruc)}</p>
      </div>
    </section>
    <section class="grid">
      <p><b>Empleado:</b> ${escapeHtml(employee.fullName)}</p>
      <p><b>Cedula:</b> ${escapeHtml(employee.cedula || 'No registrada')}</p>
      <p><b>Telefono:</b> ${escapeHtml(employee.phone || 'No registrado')}</p>
      <p><b>Generado:</b> ${escapeHtml(dateText(new Date().toISOString()))}</p>
    </section>
    <h2>Ingresos</h2>
    <table>
      <thead><tr><th>Concepto</th><th>Fecha</th><th>Valor</th></tr></thead>
      <tbody>
        <tr><td>Sueldo base</td><td>${escapeHtml(filters.desde)} a ${escapeHtml(filters.hasta)}</td><td>${money.format(fromCents(base))}</td></tr>
        ${additions.map((item) => `<tr><td>${escapeHtml(payrollAdjustmentMeta(item.type).label)} ${escapeHtml(item.note || '')}</td><td>${escapeHtml(item.date)}</td><td>${money.format(num(item.amount))}</td></tr>`).join('')}
      </tbody>
    </table>
    <h2>Descuentos</h2>
    <table>
      <thead><tr><th>Concepto</th><th>Fecha</th><th>Valor</th></tr></thead>
      <tbody>
        ${vales.map((vale) => `<tr><td>Vale - ${escapeHtml(vale.reason || 'Adelanto de sueldo')}</td><td>${escapeHtml(vale.date)}</td><td>${money.format(num(vale.amount))}</td></tr>`).join('')}
        ${deductions.map((item) => `<tr><td>${escapeHtml(payrollAdjustmentMeta(item.type).label)} ${escapeHtml(item.note || '')}</td><td>${escapeHtml(item.date)}</td><td>${money.format(num(item.amount))}</td></tr>`).join('')}
        ${!vales.length && !deductions.length ? '<tr><td colspan="3">Sin descuentos registrados.</td></tr>' : ''}
      </tbody>
    </table>
    <div class="total"><span>Total a recibir</span><span>${money.format(fromCents(total))}</span></div>
    <section class="sign">
      <div class="line">Recibi conforme</div>
      <div class="line">Autorizado por ${escapeHtml(companyInfo.name)}</div>
    </section>
  </main>
</body>
</html>`;

  payrollWindow.document.open();
  payrollWindow.document.write(html);
  payrollWindow.document.close();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function absoluteAssetUrl(path) {
  try {
    return new URL(path, window.location.origin).href;
  } catch (_error) {
    return path;
  }
}

function sortedUnique(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
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
