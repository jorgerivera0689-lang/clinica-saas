const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const QRCode = require('qrcode');

// --- 1. CONFIGURACIÓN DE FIREBASE ---
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require('./serviceAccountKey.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const auth = admin.auth();

// --- INICIALIZAR EXPRESS (Requerido antes de registrar rutas) ---
const app = express();
app.use(express.json());
app.use(cors());


// --- 2. MIDDLEWARES DE SEGURIDAD Y MULTI-TENANCY ---
const verifyToken = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Acceso denegado. Token no proporcionado.' });
  }
  try {
    const decodedToken = await auth.verifyIdToken(token);
    req.user = decodedToken; // Contiene uid, email, clinicId, role, superAdmin
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Token inválido o expirado.' });
  }
};

const verifySuperAdmin = (req, res, next) => {
  if (!req.user || !req.user.superAdmin) {
    return res.status(403).json({ error: 'Acceso exclusivo para el Super Administrador del SaaS.' });
  }
  next();
};

const verifyClinicAdmin = (req, res, next) => {
  if (!req.user || (req.user.role !== 'clinic_admin' && !req.user.superAdmin)) {
    return res.status(403).json({ error: 'Requiere permisos de administrador de clínica.' });
  }
  next();
};


// --- 3. RUTAS DEL SUPER ADMIN (Creación de Clínicas) ---
app.post('/api/admin/create-clinic', verifyToken, verifySuperAdmin, async (req, res) => {
  try {
    const { clinicName, adminEmail, adminPassword, adminName } = req.body;

    const clinicRef = db.collection('clinics').doc();
    const clinicId = clinicRef.id;

    await clinicRef.set({
      name: clinicName,
      createdAt: new Date(),
      status: 'active'
    });

    const userRecord = await auth.createUser({
      email: adminEmail,
      password: adminPassword,
      displayName: adminName,
    });

    await auth.setCustomUserClaims(userRecord.uid, {
      clinicId: clinicId,
      role: 'clinic_admin',
      superAdmin: false
    });

    await db.collection('users').doc(userRecord.uid).set({
      uid: userRecord.uid,
      email: adminEmail,
      name: adminName,
      clinicId: clinicId,
      role: 'clinic_admin',
      createdAt: new Date()
    });

    res.status(201).json({ success: true, clinicId, adminUid: userRecord.uid });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// --- 4. RUTAS DE PACIENTES, CÓDIGO QR Y CITAS ---
app.post('/api/patients/register', verifyToken, async (req, res) => {
  try {
    const { name, email, phone, birthDate } = req.body;
    const clinicId = req.user.clinicId;

    const patientRef = db.collection(`clinics/${clinicId}/patients`).doc();
    const patientId = patientRef.id;

    const qrData = JSON.stringify({ patientId, clinicId, name });
    const qrCodeImage = await QRCode.toDataURL(qrData);

    await patientRef.set({
      patientId,
      name,
      email,
      phone,
      birthDate,
      qrCode: qrCodeImage,
      createdAt: new Date()
    });

    res.status(201).json({ success: true, patientId, qrCode: qrCodeImage });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/patients/book-appointment', verifyToken, async (req, res) => {
  try {
    const { patientId, requestedDoctorId, date, time, specialty } = req.body;
    const clinicId = req.user.clinicId;

    let assignedDoctorId = requestedDoctorId;

    const shiftCheck = await db.collection(`clinics/${clinicId}/shifts`)
      .where('doctorId', '==', requestedDoctorId)
      .where('date', '==', date)
      .get();

    if (shiftCheck.empty) {
      const backupDoctor = await db.collection(`clinics/${clinicId}/staff`)
        .where('specialty', '==', specialty)
        .where('onDuty', '==', true)
        .limit(1)
        .get();

      if (!backupDoctor.empty) {
        assignedDoctorId = backupDoctor.docs[0].id;
      } else {
        return res.status(400).json({ success: false, error: 'El médico no está de turno y no hay personal de guardia disponible.' });
      }
    }

    const appointmentRef = db.collection(`clinics/${clinicId}/appointments`).doc();
    await appointmentRef.set({
      appointmentId: appointmentRef.id,
      patientId,
      doctorId: assignedDoctorId,
      date,
      time,
      specialty,
      status: 'pending_confirmation',
      createdAt: new Date()
    });

    res.status(201).json({ success: true, message: 'Cita solicitada con éxito. Pendiente de confirmación.', appointmentId: appointmentRef.id });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// --- 5. RUTAS DE TURNOS, CONTABILIDAD Y RRHH ---
app.post('/api/accounting/assign-shift', verifyToken, verifyClinicAdmin, async (req, res) => {
  try {
    const { doctorId, date, startTime, endTime } = req.body;
    const clinicId = req.user.clinicId;

    const shiftRef = db.collection(`clinics/${clinicId}/shifts`).doc();
    await shiftRef.set({
      shiftId: shiftRef.id,
      doctorId,
      date,
      startTime,
      endTime,
      onDuty: true,
      createdAt: new Date()
    });

    res.status(201).json({ success: true, message: 'Turno asignado correctamente.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/accounting/record-transaction', verifyToken, verifyClinicAdmin, async (req, res) => {
  try {
    const { type, category, amount, description } = req.body;
    const clinicId = req.user.clinicId;

    const transactionRef = db.collection(`clinics/${clinicId}/accounting`).doc();
    await transactionRef.set({
      transactionId: transactionRef.id,
      type,
      category,
      amount,
      description,
      date: new Date()
    });

    res.status(201).json({ success: true, message: 'Transacción contable registrada con éxito.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// --- 6. RUTAS DE MÉDICOS (Citas asignadas y Expediente clínico) ---
app.get('/api/doctor/appointments', verifyToken, async (req, res) => {
  try {
    const doctorId = req.user.uid;
    const clinicId = req.user.clinicId;

    const snapshot = await db.collection(`clinics/${clinicId}/appointments`)
      .where('doctorId', '==', doctorId)
      .get();

    const appointments = snapshot.docs.map(doc => doc.data());
    res.status(200).json({ success: true, appointments });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/doctor/medical-record', verifyToken, async (req, res) => {
  try {
    const { patientId, diagnosis, generalChemistry, prescription, notes } = req.body;
    const clinicId = req.user.clinicId;
    const doctorId = req.user.uid;

    const recordRef = db.collection(`clinics/${clinicId}/patients/${patientId}/medicalRecords`).doc();
    
    await recordRef.set({
      recordId: recordRef.id,
      doctorId,
      diagnosis,
      generalChemistry,
      prescription,
      notes,
      createdAt: new Date()
    });

    res.status(201).json({ success: true, message: 'Expediente clínico actualizado con éxito.', recordId: recordRef.id });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// --- 7. RUTAS DE RECURSOS HUMANOS Y NÓMINA ---
app.post('/api/hr/log-hours', verifyToken, verifyClinicAdmin, async (req, res) => {
  try {
    const { employeeId, hoursWorked, hourlyRate, date } = req.body;
    const clinicId = req.user.clinicId;

    const totalPay = hoursWorked * hourlyRate;

    const payrollRef = db.collection(`clinics/${clinicId}/payroll`).doc();
    await payrollRef.set({
      payrollId: payrollRef.id,
      employeeId,
      hoursWorked,
      hourlyRate,
      totalPay,
      date,
      createdAt: new Date()
    });

    res.status(201).json({ success: true, message: 'Registro de horas y pago calculado con éxito.', totalPay });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// --- 8. SERVIDOR PRINCIPAL ---
app.get('/', (req, res) => {
  res.send('API SaaS Clínicas Unificada funcionando al 100% 🚀');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor unificado ejecutándose en el puerto ${PORT}`);
});