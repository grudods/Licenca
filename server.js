import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { MercadoPagoConfig, Payment } from 'mercadopago';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'db.json');

const PORT = process.env.PORT || 3000;
const APP_API_KEY = process.env.APP_API_KEY || '';
const PRECO_LICENCA = Number(process.env.PRECO_LICENCA || 19.9);
const DIAS_TESTE_GRATIS = Number(process.env.DIAS_TESTE_GRATIS || 30);
const DIAS_VALIDADE_LICENCA = Number(process.env.DIAS_VALIDADE_LICENCA || 30);
const EMAIL_PADRAO_PAGADOR = process.env.EMAIL_PADRAO_PAGADOR || 'comprador@teste.com';

if (!process.env.MP_ACCESS_TOKEN) {
    console.warn('[AVISO] MP_ACCESS_TOKEN não definido no .env — a geração de Pix vai falhar até você configurar.');
}

const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN || '' });
const paymentClient = new Payment(mpClient);

/* ----------------------------- "banco de dados" em arquivo JSON -----------------------------
   Simples de propósito, pra você conseguir rodar sem configurar um banco de dados externo.
   Pra uso com muitos usuários ao mesmo tempo, troque por Postgres/SQLite/Supabase depois —
   a lógica de negócio (calcularStatus, rotas) continua igual, só troca essas 3 funções. */
function lerDB() {
    if (!fs.existsSync(DB_PATH)) return { licencas: {} };
    try {
        return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    } catch (e) {
        console.error('Erro lendo db.json, recriando do zero:', e);
        return { licencas: {} };
    }
}
function salvarDB(db) {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
function obterOuCriarLicenca(deviceId, nome, telefone) {
    const db = lerDB();
    if (!db.licencas[deviceId]) {
        db.licencas[deviceId] = {
            device_id: deviceId,
            criado_em: new Date().toISOString(),
            nome: nome || null,
            telefone: telefone || null,
            pago: false,
            pago_em: null,
            bloqueado: false,
            ultimo_pagamento_id: null,
            pagamentos_pendentes: [],
            // Overrides individuais definidos pelo admin (null = usa o padrão do .env)
            dias_teste_customizado: null,
            dias_validade_customizado: null,
            preco_customizado: null,
            // Histórico de cada cobrança gerada pra esse cliente (Pix automático ou liberação manual)
            historico_pagamentos: []
        };
        salvarDB(db);
    } else if (nome || telefone) {
        // Atualiza nome/telefone se vierem numa chamada seguinte (ex.: usuário corrigiu o número).
        if (nome) db.licencas[deviceId].nome = nome;
        if (telefone) db.licencas[deviceId].telefone = telefone;
        salvarDB(db);
    }
    return db.licencas[deviceId];
}

/* ----------------------------- regra de negócio: trial + validade ----------------------------- */
function calcularStatus(licenca) {
    const agora = new Date();
    const MS_DIA = 24 * 60 * 60 * 1000;
    // Se o admin configurou um prazo específico pra esse cliente, usa ele; senão, usa o padrão do .env.
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

/* ----------------------------- servidor ----------------------------- */
const app = express();
app.use(cors({ origin: true })); // reflete qualquer origem, inclusive "null" (WebView de APK)
app.use(express.json());

// Protege as rotas do app (não a do webhook, que é chamada pelo Mercado Pago).
function exigirApiKey(req, res, next) {
    if (!APP_API_KEY) return next(); // se você não configurou uma chave, não bloqueia (facilita testar)
    const chave = req.header('x-api-key');
    if (chave !== APP_API_KEY) return res.status(401).json({ erro: 'API key inválida' });
    next();
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Cria (na primeira vez) ou apenas retorna o status da licença de um aparelho.
app.post('/api/licenca/registrar', exigirApiKey, (req, res) => {
    const { device_id, nome, telefone } = req.body || {};
    if (!device_id) return res.status(400).json({ erro: 'device_id é obrigatório' });
    const licenca = obterOuCriarLicenca(device_id, nome, telefone);
    res.json({ device_id, ...calcularStatus(licenca) });
});

// Consulta o status atual (chamada toda vez que o app abre / periodicamente).
app.get('/api/licenca/status/:device_id', exigirApiKey, (req, res) => {
    const licenca = obterOuCriarLicenca(req.params.device_id);
    res.json({ device_id: req.params.device_id, ...calcularStatus(licenca) });
});

// Gera uma cobrança Pix vinculada ao device_id.
app.post('/api/pagamento/criar', exigirApiKey, async (req, res) => {
    const { device_id, email } = req.body || {};
    if (!device_id) return res.status(400).json({ erro: 'device_id é obrigatório' });
    const licenca = obterOuCriarLicenca(device_id);
    const valorCobrado = licenca.preco_customizado ?? PRECO_LICENCA;

    try {
        const resultado = await paymentClient.create({
            body: {
                transaction_amount: valorCobrado,
                description: 'Licença do app — 30 dias',
                payment_method_id: 'pix',
                payer: { email: email || EMAIL_PADRAO_PAGADOR },
                external_reference: device_id,
                // Pix expira em 30 min por padrão; damos 1h de folga pro cliente pagar.
                date_of_expiration: new Date(Date.now() + 60 * 60 * 1000).toISOString()
            },
            requestOptions: { idempotencyKey: `${device_id}-${Date.now()}` }
        });

        const dados = resultado.point_of_interaction?.transaction_data;
        if (!dados) throw new Error('Mercado Pago não retornou os dados do Pix (qr_code).');

        const db = lerDB();
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
        salvarDB(db);

        res.json({
            payment_id: resultado.id,
            status: resultado.status, // normalmente "pending" até o pagamento cair
            qr_code: dados.qr_code,               // código "copia e cola"
            qr_code_base64: dados.qr_code_base64, // imagem do QR Code em base64 (PNG)
            ticket_url: dados.ticket_url
        });
    } catch (erro) {
        console.error('Erro ao criar pagamento Pix:', erro);
        res.status(500).json({ erro: 'Falha ao gerar o Pix. Confira o MP_ACCESS_TOKEN no .env.' });
    }
});

// Consulta direta de um pagamento específico — usada pelo botão "Já paguei, verificar"
// como reforço caso o webhook ainda não tenha chegado.
app.get('/api/pagamento/status/:payment_id', exigirApiKey, async (req, res) => {
    try {
        const resultado = await paymentClient.get({ id: req.params.payment_id });
        if (resultado.status === 'approved') {
            marcarComoPago(resultado.external_reference, resultado.id, resultado.date_approved);
        }
        res.json({ status: resultado.status });
    } catch (erro) {
        console.error('Erro ao consultar pagamento:', erro);
        res.status(500).json({ erro: 'Falha ao consultar pagamento' });
    }
});

function marcarComoPago(deviceId, paymentId, dataAprovacao) {
    if (!deviceId) return;
    const db = lerDB();
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
    salvarDB(db);
    console.log(`Licença liberada para ${deviceId} (pagamento ${paymentId})`);
}

// Webhook chamado pelo Mercado Pago quando o status de um pagamento muda.
// Configure esta URL em: Painel de Desenvolvedores > Sua aplicação > Webhooks.
app.post('/api/webhook/mercadopago', async (req, res) => {
    try {
        const tipo = req.body?.type || req.query?.type;
        const paymentId = req.body?.data?.id || req.query['data.id'];
        if (tipo === 'payment' && paymentId) {
            const resultado = await paymentClient.get({ id: paymentId });
            if (resultado.status === 'approved') {
                marcarComoPago(resultado.external_reference, resultado.id, resultado.date_approved);
            }
        }
        res.sendStatus(200); // sempre responda 200 rápido, senão o Mercado Pago fica reenviando
    } catch (erro) {
        console.error('Erro no webhook:', erro);
        res.sendStatus(200);
    }
});

/* ----------------------------- Painel administrativo ----------------------------- */
// Protegido por HTTP Basic Auth. O navegador pede usuário/senha uma vez e reaproveita
// em todas as chamadas seguintes — não precisei inventar sistema de login próprio.
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
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Lista todos os clientes/licenças com o status já calculado, mais um resumo.
app.get('/api/admin/licencas', exigirAdmin, (req, res) => {
    const db = lerDB();
    const lista = Object.values(db.licencas)
        .map(l => ({ ...l, ...calcularStatus(l) }))
        .sort((a, b) => new Date(b.criado_em) - new Date(a.criado_em));
    const resumo = {
        total: lista.length,
        pagos: lista.filter(l => l.status === 'pago').length,
        em_teste: lista.filter(l => l.status === 'trial').length,
        expirados: lista.filter(l => l.status === 'expirado').length
    };
    res.json({ resumo, licencas: lista });
});

// Libera manualmente (ex.: cliente pagou em dinheiro/na mão).
app.post('/api/admin/licencas/:device_id/liberar', exigirAdmin, (req, res) => {
    const db = lerDB();
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
    salvarDB(db);
    res.json({ ok: true, ...calcularStatus(licenca) });
});

// Bloqueia manualmente (ex.: pagamento estornado, uso indevido, teste de segurança).
app.post('/api/admin/licencas/:device_id/bloquear', exigirAdmin, (req, res) => {
    const db = lerDB();
    const licenca = db.licencas[req.params.device_id];
    if (!licenca) return res.status(404).json({ erro: 'Licença não encontrada' });
    licenca.bloqueado = true;
    salvarDB(db);
    res.json({ ok: true, ...calcularStatus(licenca) });
});

// Desfaz um bloqueio manual, sem marcar como pago (volta a valer o teste/pagamento normal).
app.post('/api/admin/licencas/:device_id/desbloquear', exigirAdmin, (req, res) => {
    const db = lerDB();
    const licenca = db.licencas[req.params.device_id];
    if (!licenca) return res.status(404).json({ erro: 'Licença não encontrada' });
    licenca.bloqueado = false;
    salvarDB(db);
    res.json({ ok: true, ...calcularStatus(licenca) });
});

// Define (ou reseta, enviando null) prazo de teste, validade e preço individuais pra esse cliente.
// Não recalcula nada de imediato — o novo valor só entra em vigor no próximo cálculo de status
// (ou seja, some/aparece a tela de bloqueio na próxima checagem, automática ou manual).
app.post('/api/admin/licencas/:device_id/config', exigirAdmin, (req, res) => {
    const db = lerDB();
    const licenca = db.licencas[req.params.device_id];
    if (!licenca) return res.status(404).json({ erro: 'Licença não encontrada' });
    const { dias_teste, dias_validade, preco } = req.body || {};
    licenca.dias_teste_customizado = (dias_teste === '' || dias_teste === null || dias_teste === undefined) ? null : Number(dias_teste);
    licenca.dias_validade_customizado = (dias_validade === '' || dias_validade === null || dias_validade === undefined) ? null : Number(dias_validade);
    licenca.preco_customizado = (preco === '' || preco === null || preco === undefined) ? null : Number(preco);
    salvarDB(db);
    res.json({ ok: true, ...calcularStatus(licenca) });
});

app.listen(PORT, () => console.log(`Backend de licença rodando na porta ${PORT}`));
