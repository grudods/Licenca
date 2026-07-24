# Backend de Licença — Teste 30 dias + Pagamento Pix + Painel Admin

## ⚠️ CORREÇÃO URGENTE — leia antes de reimplantar (23/07/2026)

Se seu painel estava "esquecendo" clientes (sumindo os que pagaram/foram bloqueados, e
mostrando teste novo pra quem já tinha licença), a causa era esta: **o Render, no plano
grátis, apaga o disco do servidor toda vez que ele reinicia ou hiberna por inatividade** —
e isso acontecia com frequência, já que o plano free hiberna sozinho depois de um tempo
sem uso. Os dados estavam sendo salvos num arquivo local (`db.json`), que se perdia junto.

A partir desta versão, os dados são salvos no **Upstash Redis** (gratuito, e persiste de
verdade — não se apaga sozinho). Você precisa criar essa conta e configurar 2 variáveis
novas antes de reimplantar, ou o problema volta a acontecer:

1. Acesse 🔗 https://upstash.com e crie uma conta grátis (dá pra entrar com GitHub).
2. **Create Database** → dê um nome (ex.: `licencas`) → tipo **Regional** → escolha uma região perto do Brasil (ex.: `us-east-1` ou `sa-east-1` se disponível) → **Create**.
3. Na página do banco criado, ache a seção **REST API** → copie a **UPSTASH_REDIS_REST_URL** e o **UPSTASH_REDIS_REST_TOKEN**.
4. No Render, no seu serviço → **Environment** → adicione essas duas variáveis com os valores copiados.
5. Suba os arquivos atualizados (`server.js`, `admin.html`, `.env.example`, `README.md`) no GitHub, substituindo os antigos.
6. No Render: **Manual Deploy → Deploy latest commit**.
7. Confira em `https://seu-backend.onrender.com/api/health` — precisa aparecer `"banco":"conectado"`. Se aparecer `"NÃO CONFIGURADO"`, as variáveis não foram salvas corretamente.

**Os clientes que sumiram durante o problema precisam ser recadastrados** — não tem
como recuperar o que já foi perdido antes dessa correção. Dá pra usar o botão
**"Liberar (pago)"** no painel pra quem realmente já pagou, assim que a licença dele
reaparecer (é só pedir pra abrir o app de novo, o registro é automático).

---

Esse servidor faz 4 coisas:
1. Controla o teste grátis de 30 dias de cada aparelho.
2. Pede nome + WhatsApp na primeira abertura (ajuda a identificar cada cliente).
3. Gera uma cobrança Pix (QR Code + código copia-e-cola) via Mercado Pago, e libera sozinho quando o cliente paga.
4. Tem um **painel administrativo** (`/admin`) pra você ver todos os clientes e liberar/bloquear manualmente — útil pra pagamento em dinheiro ou correção de erro.

---

## GUIA COMPLETO — do zero até o APK pronto

### 1. Crie uma conta no GitHub
🔗 https://github.com/signup
É lá que o código do backend vai ficar guardado, pra você poder publicá-lo.

### 2. Crie um repositório e suba a pasta `backend`
- No GitHub, clique em **New repository**, dê um nome (ex.: `licenca-emprestimos`) e crie.
- Suba os arquivos da pasta `backend/` desse pacote (pelo site mesmo, arrastando os arquivos, sem precisar saber usar linha de comando).

### 3. Crie sua conta de desenvolvedor no Mercado Pago
🔗 https://www.mercadopago.com.br/developers
- Faça login com sua conta Mercado Pago normal (ou crie uma).
- Vá em **"Suas integrações"** → **Criar aplicação** (qualquer nome).
- Na aba **Credenciais de teste**, copie o **Access Token** (começa com `TEST-`). Use esse primeiro pra testar sem mexer com dinheiro real.
- Depois de testar tudo, pegue o **Access Token de produção** na aba de credenciais de produção.

### 4. Publique o backend no Render (grátis)
🔗 https://render.com
- Crie conta (dá pra entrar direto com o GitHub).
- **New → Web Service** → conecte o repositório que você criou no passo 2.
- Configure:
  - **Build command:** `npm install`
  - **Start command:** `npm start`
- Em **Environment**, adicione as variáveis (copie do `.env.example`):
  - `MP_ACCESS_TOKEN` (o do passo 3)
  - `APP_API_KEY` (invente uma senha longa só sua)
  - `ADMIN_USER` e `ADMIN_PASSWORD` (login do painel admin — senha forte!)
  - `PRECO_LICENCA`, `DIAS_TESTE_GRATIS`, `DIAS_VALIDADE_LICENCA`, `EMAIL_PADRAO_PAGADOR`
- Clique em **Create Web Service** e espere o deploy. Você vai receber uma URL tipo `https://seu-app.onrender.com`.

⚠️ No plano gratuito, o servidor "dorme" depois de um tempo sem uso e demora
alguns segundos pra acordar na próxima chamada — normal, o app só vai levar
um pouco mais pra confirmar a licença na primeira abertura do dia.

### 5. Configure o Webhook no Mercado Pago
No painel de desenvolvedores → sua aplicação → **Webhooks** → adicione:
```
https://seu-app.onrender.com/api/webhook/mercadopago
```
Marque o evento **Pagamentos**. É isso que avisa seu servidor quando alguém paga.

### 6. Edite o app com a URL e a chave do seu backend
Abra o `index.html` (o app) e edite:
```javascript
const LICENCA_CONFIG = {
    BACKEND_URL: 'https://seu-app.onrender.com',
    API_KEY: 'a-mesma-senha-que-você-colocou-em-APP_API_KEY'
};
```

### 7. Transforme o HTML em APK
Pela ferramenta que você já estava usando nas capturas de tela (parece ser o
**FreeWebToApk** — 🔗 https://freewebtoapk.com — mas se for outra parecida o processo é o mesmo):
- Opção **"HTML"** → suba o `index.html` já editado (ou use **Offline ZIP** com `index.html` + `sw.js` juntos).
- Na etapa **Permissões**, confirme que **Internet** está marcada — sem isso o app não consegue checar a licença nem gerar Pix.
- Nas opções da etapa "Integrar" (AdMob, Push Notifications/OneSignal, Live Chat, PIN Lock), pode deixar tudo desligado — nenhuma delas tem a ver com o seu sistema de licença, que já funciona sozinho.
- Gere o APK.

### 8. (Opcional) Publicar na Play Store
🔗 https://play.google.com/console
Taxa única de registro de desenvolvedor (cobrada pelo Google, não por mim). Antes de publicar, vale reler o aviso que te dei sobre a política de cobrança dentro de apps da Play Store.

---

## Passo a passo pra testar localmente (opcional, antes de publicar)

```bash
cd backend
npm install
cp .env.example .env
# edite o .env com seus valores
npm start
```
Servidor sobe em `http://localhost:3000`. O painel fica em `http://localhost:3000/admin`.

---

## Como usar o Painel Administrativo

Acesse `https://seu-app.onrender.com/admin` no navegador do computador ou celular.
O navegador vai pedir usuário e senha — use o `ADMIN_USER`/`ADMIN_PASSWORD` que
você configurou no passo 4.

Lá você vê:
- **Quantos clientes** tem no total, quantos pagaram, quantos estão em teste, quantos expiraram.
- **Nome e WhatsApp** de cada um (informado na primeira abertura do app dele).
- Botão **"Liberar (pago)"** — usa quando o cliente pagou em mão/dinheiro/fora do Pix automático. Libera a licença por mais `DIAS_VALIDADE_LICENCA` dias na hora.
- Botão **"Bloquear"** — corta o acesso na hora (ex.: pagamento estornado, chargeback, ou qualquer suspeita). Some com o botão e vira **"Desbloquear"**.
- Botão **"Config"** — define preço, dias de teste e dias de validade **diferentes do padrão só pra aquele cliente** (ex.: dar um desconto, um teste maior, ou uma cortesia). Deixe os campos em branco pra voltar a usar o padrão geral.
- Botão **"Histórico"** — mostra todas as cobranças já geradas pra aquele cliente (Pix automático e liberações manuais), com valor, status e datas.
- Tag **"⚠️ mesmo IP"** — aparece quando outro cliente já criou uma licença usando a mesma internet (Wi-Fi/dados) que esse. Não bloqueia sozinho (duas pessoas podem legitimamente estar na mesma casa/rede), mas é um indício de reinstalação pra resetar o teste — vale olhar o histórico e nome/telefone antes de decidir bloquear.

A lista atualiza sozinha a cada 30 segundos.

---

## Sobre segurança e tentativas de burlar o sistema

Sendo direto com você sobre os limites reais disso:

- **O contador de dias é todo calculado no servidor**, não no celular do
  cliente. Isso já bloqueia o truque mais óbvio, que seria mudar a data/hora
  do celular pra "voltar no tempo" — não adianta, porque quem manda na
  contagem é o seu backend, não o aparelho.
- **O ponto fraco real:** se o cliente desinstalar o app e instalar de novo
  (ou limpar os dados do app), ele ganha um `device_id` novo e, tecnicamente,
  um novo teste de 30 dias — porque um app rodando dentro de um WebView
  simples (qualquer conversor HTML→APK, não só o que você está usando) não
  tem acesso a nenhum identificador de hardware que sobreviva a isso. Isso
  não é uma falha do meu código — é uma trava de privacidade do próprio
  Android, que nenhum "HTML para APK" contorna.
- **Duas camadas de indício, agora:** nome + WhatsApp informados na primeira
  abertura, e a tag de "mesmo IP" no painel. Nenhuma das duas *impede*
  o truque (o nome pode ser inventado, o IP muda se a pessoa trocar de
  rede), mas juntas dão bastante visibilidade pra você notar o padrão
  (mesmo IP, nomes diferentes, criados em sequência) e bloquear na mão.
- **Se algum dia isso virar um problema sério de verdade**, a solução
  definitiva é migrar de "site empacotado em WebView" para um app nativo de
  verdade (ex. construído com Capacitor), que aí sim consegue usar
  identificadores de instalação mais robustos e a Play Integrity API do
  Google. É bem mais trabalho, então só vale a pena se o número de tentativas
  de burlar realmente justificar.

## Sobre o painel no seu celular

Você não precisa de um app separado pra isso: abra `https://seu-backend.onrender.com/admin`
no Chrome do celular, toque no menu (⋮) → **"Adicionar à tela inicial"**. Fica um ícone
que abre o painel em tela cheia, como um app — e agora que os dados persistem de verdade
no Upstash, ele sempre vai mostrar a lista completa e atualizada, não importa quando você abrir.
