import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { MercadoPagoConfig, Payment } from 'mercadopago';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const APP_API_KEY = process.env.APP_API_KEY || '';
const PRECO_LICENCA = Number(process.env.PRECO_LICENCA || 19.9);
const DIAS_TESTE_GRATIS = Number(process.env.DIAS_TESTE_GRATIS || 30);
const DIAS_VALIDADE_LICENCA = Number(process.env.DIAS_VALIDADE_LICENCA || 30);
const EMAIL_PADRAO_PAGADOR = process.env.EMAIL_PADRAO_PAGADOR || 'comprador@teste.com';

if (!process.env.MP_ACCESS_TOKEN) {
    console.warn('[AVISO] MP_ACCESS_TOKEN não definido no .env — a geração de Pix vai falhar até você configurar.');
}
if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    console.warn('[AVISO] UPSTASH_REDIS_REST_URL/TOKEN não definidos — sem isso os dados de licença NÃO persistem no plano free do Render (somem a cada hibernação/redeploy). Veja o README.');
}

const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN || '' });
const paymentClient = new Payment(mpClient);

/* ----------------------------- banco de dados (Upstash Redis) ----------------------------- */
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function upstash(comando) {
    const resposta = await fetch(UPSTASH_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(comando)
    });
    const dados = await resposta.json();
    if (dados.error) throw new Error('Upstash: ' + dados.error);
    return dados.result;
}

async function lerDB() {
    if (!UPSTASH_URL || !UPSTASH_TOKEN) return { licencas: {} };
    try {
        const bruto = await upstash(['GET', 'licencas_db']);
        return bruto ? JSON.parse(bruto) : { licencas: {} };
    } catch (e) {
        console.error('Erro lendo banco de dados:', e);
        return { licencas: {} };
    }
}
async function salvarDB(db) {
    if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
    await upstash(['SET', 'licencas_db', JSON.stringify(db)]);
}

async function obterOuCriarLicenca(deviceId, nome, telefone, ip) {
    const db = await lerDB();
    const agora = new Date().toISOString();
    if (!db.licencas[deviceId]) {
        db.licencas[deviceId] = {
            device_id: deviceId,
            criado_em: agora,
            ultima_verificacao: agora,
            nome: nome || null,
            telefone: telefone || null,
            ip_criacao: ip || null,
            pago: false,
            pago_em: null,
            bloqueado: false,
            ultimo_pagamento_id: null,
            pagamentos_pendentes: [],
            dias_teste_customizado: null,
            dias_validade_customizado: null,
            preco_customizado: null,
            historico_pagamentos: []
        };
    } else {
        db.licencas[deviceId].ultima_verificacao = agora;
        if (nome) db.licencas[deviceId].nome = nome;
        if (telefone) db.licencas[deviceId].telefone = telefone;
    }
    await salvarDB(db);
    return db.licencas[deviceId];
}

/* ----------------------------- regra de negócio: trial + validade ----------------------------- */
function calcularStatus(licenca) {
    const agora = new Date();
    const MS_DIA = 24 * 60 * 60 * 1000;
    const diasTesteEfetivo = licenca.dias_teste_customizado ?? DIAS_TESTE_GRATIS;
    const diasValidadeEfetivo = licenca.dias_validade_customizado ?? DIAS_VALIDADE_LICENCA;

    if (licenca.bloqueado) {
        return { status: 'expirado', dias_restantes: 0, motivo: 'bloqueado_pelo_admin' };
    }

    if (licenca.pago && licenca.pago_em) {
        const expiraEm = new Date(new Date(licenca.pago_em).getTime() + diasValidadeEfetivo * MS_DIA);
        const diasRestantes = Math.ceil((expiraEm - agora) / MS_DIA);
        if (diasRestantes > 0) {
            return { status: 'pago', dias_restantes: diasRestantes, expira_em: expiraEm.toISOString() };
        }
        return { status: 'expirado', dias_restantes: 0, expira_em: expiraEm.toISOString() };
    }

    const trialFim = new Date(new Date(licenca.criado_em).getTime() + diasTesteEfetivo * MS_DIA);
    const diasRestantes = Math.ceil((trialFim - agora) / MS_DIA);
    if (diasRestantes > 0) {
        return { status: 'trial', dias_restantes: diasRestantes, expira_em: trialFim.toISOString() };
    }
    return { status: 'expirado', dias_restantes: 0, expira_em: trialFim.toISOString() };
}

function obterIp(req) {
    const encaminhado = req.headers['x-forwarded-for'];
    if (encaminhado) return encaminhado.split(',')[0].trim();
    return req.socket?.remoteAddress || null;
}

/* ----------------------------- servidor ----------------------------- */
const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

function exigirApiKey(req, res, next) {
    if (!APP_API_KEY) return next();
    const chave = req.header('x-api-key');
    if (chave !== APP_API_KEY) return res.status(401).json({ erro: 'API key inválida' });
    next();
}

app.get('/api/health', (req, res) => res.json({ ok: true, banco: (UPSTASH_URL && UPSTASH_TOKEN) ? 'conectado' : 'NÃO CONFIGURADO' }));

app.post('/api/licenca/registrar', exigirApiKey, async (req, res) => {
    const { device_id, nome, telefone } = req.body || {};
    if (!device_id) return res.status(400).json({ erro: 'device_id é obrigatório' });
    const licenca = await obterOuCriarLicenca(device_id, nome, telefone, obterIp(req));
    res.json({ device_id, ...calcularStatus(licenca) });
});

app.get('/api/licenca/status/:device_id', exigirApiKey, async (req, res) => {
    const licenca = await obterOuCriarLicenca(req.params.device_id, null, null, obterIp(req));
    res.json({ device_id: req.params.device_id, ...calcularStatus(licenca) });
});

app.post('/api/pagamento/criar', exigirApiKey, async (req, res) => {
    const { device_id, email } = req.body || {};
    if (!device_id) return res.status(400).json({ erro: 'device_id é obrigatório' });
    const licenca = await obterOuCriarLicenca(device_id, null, null, obterIp(req));
    const valorCobrado = licenca.preco_customizado ?? PRECO_LICENCA;

    try {
        const resultado = await paymentClient.create({
            body: {
                transaction_amount: valorCobrado,
                description: 'Licença do app — 30 dias',
                payment_method_id: 'pix',
                payer: { email: email || EMAIL_PADRAO_PAGADOR },
                external_reference: device_id,
                date_of_expiration: new Date(Date.now() + 60 * 60 * 1000).toISOString()
            },
            requestOptions: { idempotencyKey: `${device_id}-${Date.now()}` }
        });

        const dados = resultado.point_of_interaction?.transaction_data;
        if (!dados) throw new Error('Mercado Pago não retornou os dados do Pix (qr_code).');

        const db = await lerDB();
        db.licencas[device_id].pagamentos_pendentes.push(String(resultado.id));
        if (!db.licencas[device_id].historico_pagamentos) db.licencas[device_id].historico_pagamentos = [];
        db.licencas[device_id].historico_pagamentos.push({
            payment_id: String(resultado.id),
            valor: valorCobrado,
            metodo: 'pix',
            status: 'pending',
            criado_em: new Date().toISOString(),
            aprovado_em: null
        });
        await salvarDB(db);

        res.json({
            payment_id: resultado.id,
            status: resultado.status,
            qr_code: dados.qr_code,
            qr_code_base64: dados.qr_code_base64,
            ticket_url: dados.ticket_url
        });
    } catch (erro) {
        console.error('Erro ao criar pagamento Pix:', erro);
        res.status(500).json({ erro: 'Falha ao gerar o Pix. Confira o MP_ACCESS_TOKEN no .env.' });
    }
});

app.get('/api/pagamento/status/:payment_id', exigirApiKey, async (req, res) => {
    try {
        const resultado = await paymentClient.get({ id: req.params.payment_id });
        if (resultado.status === 'approved') {
            await marcarComoPago(resultado.external_reference, resultado.id, resultado.date_approved);
        }
        res.json({ status: resultado.status });
    } catch (erro) {
        console.error('Erro ao consultar pagamento:', erro);
        res.status(500).json({ erro: 'Falha ao consultar pagamento' });
    }
});

async function marcarComoPago(deviceId, paymentId, dataAprovacao) {
    if (!deviceId) return;
    const db = await lerDB();
    if (!db.licencas[deviceId]) return;
    db.licencas[deviceId].pago = true;
    db.licencas[deviceId].pago_em = dataAprovacao || new Date().toISOString();
    db.licencas[deviceId].ultimo_pagamento_id = String(paymentId);
    if (!db.licencas[deviceId].historico_pagamentos) db.licencas[deviceId].historico_pagamentos = [];
    const entrada = db.licencas[deviceId].historico_pagamentos.find(h => h.payment_id === String(paymentId));
    if (entrada) {
        entrada.status = 'approved';
        entrada.aprovado_em = dataAprovacao || new Date().toISOString();
    } else {
        db.licencas[deviceId].historico_pagamentos.push({
            payment_id: String(paymentId), valor: null, metodo: 'pix', status: 'approved',
            criado_em: dataAprovacao || new Date().toISOString(), aprovado_em: dataAprovacao || new Date().toISOString()
        });
    }
    await salvarDB(db);
    console.log(`Licença liberada para ${deviceId} (pagamento ${paymentId})`);
}

app.post('/api/webhook/mercadopago', async (req, res) => {
    try {
        const tipo = req.body?.type || req.query?.type;
        const paymentId = req.body?.data?.id || req.query['data.id'];
        if (tipo === 'payment' && paymentId) {
            const resultado = await paymentClient.get({ id: paymentId });
            if (resultado.status === 'approved') {
                await marcarComoPago(resultado.external_reference, resultado.id, resultado.date_approved);
            }
        }
        res.sendStatus(200);
    } catch (erro) {
        console.error('Erro no webhook:', erro);
        res.sendStatus(200);
    }
});

/* ----------------------------- Painel administrativo ----------------------------- */
function exigirAdmin(req, res, next) {
    if (!process.env.ADMIN_PASSWORD) {
        return res.status(500).send('Configure ADMIN_USER e ADMIN_PASSWORD no .env do servidor antes de acessar o painel.');
    }
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Basic ')) {
        res.set('WWW-Authenticate', 'Basic realm="Painel Admin"');
        return res.status(401).send('Autenticação necessária');
    }
    const [usuario, senha] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
    const usuarioValido = crypto.timingSafeEqual(
        Buffer.from(String(usuario).padEnd(64)), Buffer.from(String(process.env.ADMIN_USER || 'admin').padEnd(64))
    );
    const senhaValida = crypto.timingSafeEqual(
        Buffer.from(String(senha).padEnd(64)), Buffer.from(String(process.env.ADMIN_PASSWORD).padEnd(64))
    );
    if (!usuarioValido || !senhaValida) {
        res.set('WWW-Authenticate', 'Basic realm="Painel Admin"');
        return res.status(401).send('Credenciais inválidas');
    }
    next();
}

app.get('/admin', exigirAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/api/admin/licencas', exigirAdmin, async (req, res) => {
    const db = await lerDB();
    const todas = Object.values(db.licencas);
    const contagemPorIp = {};
    todas.forEach(l => { if (l.ip_criacao) contagemPorIp[l.ip_criacao] = (contagemPorIp[l.ip_criacao] || 0) + 1; });
    const agora = Date.now();
    const MS_DIA = 24 * 60 * 60 * 1000;

    const prioridadeStatus = { pago: 0, trial: 1, expirado: 2 };

    const lista = todas
        .map(l => {
            const status = calcularStatus(l);
            const ultimaVez = l.ultima_verificacao || l.criado_em;
            const diasInativo = Math.floor((agora - new Date(ultimaVez).getTime()) / MS_DIA);
            return {
                ...l,
                ...status,
                mesmo_ip_outros: l.ip_criacao ? (contagemPorIp[l.ip_criacao] - 1) : 0,
                dias_inativo: diasInativo
            };
        })
        .sort((a, b) => {
            const p = prioridadeStatus[a.status] - prioridadeStatus[b.status];
            if (p !== 0) return p;
            return a.dias_inativo - b.dias_inativo;
        });
    const resumo = {
        total: lista.length,
        pagos: lista.filter(l => l.status === 'pago').length,
        em_teste: lista.filter(l => l.status === 'trial').length,
        expirados: lista.filter(l => l.status === 'expirado').length
    };
    res.json({ resumo, licencas: lista, banco_conectado: !!(UPSTASH_URL && UPSTASH_TOKEN) });
});

app.post('/api/admin/licencas/:device_id/liberar', exigirAdmin, async (req, res) => {
    const db = await lerDB();
    const licenca = db.licencas[req.params.device_id];
    if (!licenca) return res.status(404).json({ erro: 'Licença não encontrada' });
    licenca.pago = true;
    licenca.pago_em = new Date().toISOString();
    licenca.bloqueado = false;
    licenca.ultimo_pagamento_id = 'liberado-manualmente-pelo-admin';
    if (!licenca.historico_pagamentos) licenca.historico_pagamentos = [];
    licenca.historico_pagamentos.push({
        payment_id: 'manual-' + Date.now(),
        valor: licenca.preco_customizado ?? PRECO_LICENCA,
        metodo: 'manual (dinheiro/outro)',
        status: 'approved',
        criado_em: new Date().toISOString(),
        aprovado_em: new Date().toISOString()
    });
    await salvarDB(db);
    res.json({ ok: true, ...calcularStatus(licenca) });
});

app.post('/api/admin/licencas/:device_id/bloquear', exigirAdmin, async (req, res) => {
    const db = await lerDB();
    const licenca = db.licencas[req.params.device_id];
    if (!licenca) return res.status(404).json({ erro: 'Licença não encontrada' });
    licenca.bloqueado = true;
    await salvarDB(db);
    res.json({ ok: true, ...calcularStatus(licenca) });
});

app.post('/api/admin/licencas/:device_id/desbloquear', exigirAdmin, async (req, res) => {
    const db = await lerDB();
    const licenca = db.licencas[req.params.device_id];
    if (!licenca) return res.status(404).json({ erro: 'Licença não encontrada' });
    licenca.bloqueado = false;
    await salvarDB(db);
    res.json({ ok: true, ...calcularStatus(licenca) });
});

app.post('/api/admin/licencas/:device_id/config', exigirAdmin, async (req, res) => {
    const db = await lerDB();
    const licenca = db.licencas[req.params.device_id];
    if (!licenca) return res.status(404).json({ erro: 'Licença não encontrada' });
    const { dias_teste, dias_validade, preco } = req.body || {};
    licenca.dias_teste_customizado = (dias_teste === '' || dias_teste === null || dias_teste === undefined) ? null : Number(dias_teste);
    licenca.dias_validade_customizado = (dias_validade === '' || dias_validade === null || dias_validade === undefined) ? null : Number(dias_validade);
    licenca.preco_customizado = (preco === '' || preco === null || preco === undefined) ? null : Number(preco);
    await salvarDB(db);
    res.json({ ok: true, ...calcularStatus(licenca) });
});

app.delete('/api/admin/licencas/:device_id', exigirAdmin, async (req, res) => {
    const db = await lerDB();
    if (!db.licencas[req.params.device_id]) return res.status(404).json({ erro: 'Licença não encontrada' });
    delete db.licencas[req.params.device_id];
    await salvarDB(db);
    res.json({ ok: true });
});

app.post('/api/admin/licencas/limpar-inativos', exigirAdmin, async (req, res) => {
    const diasLimite = Number(req.body?.dias) || 3;
    const db = await lerDB();
    const agora = Date.now();
    const MS_DIA = 24 * 60 * 60 * 1000;
    let apagados = 0;
    for (const id of Object.keys(db.licencas)) {
        const l = db.licencas[id];
        if (l.pago) continue;
        const ultimaVez = l.ultima_verificacao || l.criado_em;
        const diasInativo = Math.floor((agora - new Date(ultimaVez).getTime()) / MS_DIA);
        if (diasInativo >= diasLimite) {
            delete db.licencas[id];
            apagados++;
        }
    }
    if (apagados > 0) await salvarDB(db);
    res.json({ ok: true, apagados });
});

// ✅ AJUSTE OBRIGATÓRIO PARA O RENDER: escutar na porta dinâmica e IP '0.0.0.0'
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend de licença rodando na porta ${PORT}`);
});
