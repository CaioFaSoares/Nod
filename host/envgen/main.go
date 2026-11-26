package main

import (
	"bufio"
	"fmt"
	"io"
	"net/url"
	"os"
	"strconv"
	"strings"
)

type Mode int

const (
	ModeDuckDNS Mode = iota + 1
	ModeCoolifyHTTPS
	ModeCoolifyTempHTTP
	ModeTunnelOrDirect
)

type EnvEntry struct {
	Key   string
	Value string
}

type Plan struct {
	ComposeFile string
	Entries     []EnvEntry
	Notes       []string
}

type PortRange struct {
	Min int
	Max int
}

func parsePort(raw string) (int, error) {
	p, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || p < 1 || p > 65535 {
		return 0, fmt.Errorf("porta inválida %q (use 1..65535)", raw)
	}
	return p, nil
}

// parsePortRange accepts either a single port ("8443") or an inclusive range ("8440-8450").
func parsePortRange(raw string) (PortRange, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return PortRange{}, fmt.Errorf("range vazio")
	}
	if !strings.Contains(s, "-") {
		p, err := parsePort(s)
		if err != nil {
			return PortRange{}, err
		}
		return PortRange{Min: p, Max: p}, nil
	}
	parts := strings.Split(s, "-")
	if len(parts) != 2 {
		return PortRange{}, fmt.Errorf("formato inválido %q (use ex: 8440-8450)", raw)
	}
	minP, err := parsePort(parts[0])
	if err != nil {
		return PortRange{}, err
	}
	maxP, err := parsePort(parts[1])
	if err != nil {
		return PortRange{}, err
	}
	if minP > maxP {
		return PortRange{}, fmt.Errorf("range invertido %d-%d", minP, maxP)
	}
	return PortRange{Min: minP, Max: maxP}, nil
}

// normalizeDuckDomain builds `<name>.duckdns.org` from either `advteam-nod` or `advteam-nod.duckdns.org`.
func normalizeDuckDomain(raw string) (string, error) {
	r := strings.ToLower(strings.TrimSpace(raw))
	r = strings.TrimPrefix(r, "https://")
	r = strings.TrimPrefix(r, "http://")
	r = strings.TrimSuffix(r, "/")
	r = strings.TrimSuffix(r, ".duckdns.org")
	r = strings.Trim(r, ".")
	if r == "" || strings.ContainsAny(r, " /:\\.") {
		return "", fmt.Errorf("subdomínio DuckDNS inválido: %q (use ex: advteam-nod)", raw)
	}
	return r + ".duckdns.org", nil
}

func normalizeHttpsURL(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", fmt.Errorf("endereço vazio")
	}
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Hostname() == "" {
		return "", fmt.Errorf("URL inválida: %q", raw)
	}
	if u.Scheme != "https" {
		return "", fmt.Errorf("este modo exige https:// (recebido %s://)", u.Scheme)
	}
	return strings.TrimSuffix(u.String(), "/"), nil
}

func normalizeHttpURL(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", fmt.Errorf("endereço vazio")
	}
	if !strings.Contains(s, "://") {
		s = "http://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Hostname() == "" {
		return "", fmt.Errorf("URL inválida: %q", raw)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("esquema inválido: %s", u.Scheme)
	}
	return strings.TrimSuffix(u.String(), "/"), nil
}

func formatPublicURL(domain string, httpsPort int) string {
	if httpsPort == 443 {
		return "https://" + domain
	}
	return fmt.Sprintf("https://%s:%d", domain, httpsPort)
}

func formatPlan(p Plan) string {
	var b strings.Builder
	b.WriteString("\n================ COOLIFY / .ENV ================\n")
	fmt.Fprintf(&b, "# Compose: %s\n", p.ComposeFile)
	for _, e := range p.Entries {
		fmt.Fprintf(&b, "%s=%s\n", e.Key, e.Value)
	}
	b.WriteString("================================================\n")
	for _, n := range p.Notes {
		fmt.Fprintf(&b, "Nota: %s\n", n)
	}
	return b.String()
}

type prompter struct {
	r *bufio.Reader
	w io.Writer
}

func (p *prompter) ask(label, def string) string {
	if def != "" {
		fmt.Fprintf(p.w, "%s [%s]: ", label, def)
	} else {
		fmt.Fprintf(p.w, "%s: ", label)
	}
	line, _ := p.r.ReadString('\n')
	val := strings.TrimSpace(line)
	if val == "" {
		return def
	}
	return val
}

func (p *prompter) askRequired(label string) string {
	for {
		val := p.ask(label, "")
		if val != "" {
			return val
		}
		fmt.Fprintln(p.w, "  Campo obrigatório.")
	}
}

func (p *prompter) askPort(label string, def int, rng *PortRange) int {
	for {
		raw := p.ask(label, strconv.Itoa(def))
		port, err := parsePort(raw)
		if err != nil {
			fmt.Fprintf(p.w, "  %v\n", err)
			continue
		}
		if rng != nil && (port < rng.Min || port > rng.Max) {
			fmt.Fprintf(p.w, "  Aviso: porta %d fora do range informado (%d-%d).\n", port, rng.Min, rng.Max)
			confirm := strings.ToLower(p.ask("  Usar assim mesmo? (s/N)", "n"))
			if confirm != "s" && confirm != "sim" {
				continue
			}
		}
		return port
	}
}

func (p *prompter) askBool(label string, def bool) bool {
	defStr := "S/n"
	if !def {
		defStr = "s/N"
	}
	for {
		raw := strings.ToLower(p.ask(label+" ("+defStr+")", ""))
		if raw == "" {
			return def
		}
		if raw == "s" || raw == "sim" || raw == "y" || raw == "yes" {
			return true
		}
		if raw == "n" || raw == "nao" || raw == "não" || raw == "no" {
			return false
		}
		fmt.Fprintln(p.w, "  Responda s ou n.")
	}
}

func runWizard(in io.Reader, out io.Writer) (Plan, error) {
	pr := &prompter{r: bufio.NewReader(in), w: out}

	fmt.Fprintln(out, "Nod — Gerador de .env para deploy (Coolify / Docker Compose)")
	fmt.Fprintln(out, "")
	fmt.Fprintln(out, "Escolha o contexto do servidor:")
	fmt.Fprintln(out, "  1) DuckDNS + Caddy (sem domínio próprio, só porta específica aberta)")
	fmt.Fprintln(out, "  2) Coolify + Traefik HTTPS (com domínio próprio apontado)")
	fmt.Fprintln(out, "  3) Coolify URL temporária HTTP (só Portal Web, NOD_DEV=1)")
	fmt.Fprintln(out, "  4) Host direto / Túnel (Tailscale Serve ou SSH)")

	var mode Mode
	for {
		choice := pr.ask("Opção", "1")
		n, err := strconv.Atoi(choice)
		if err == nil && n >= 1 && n <= 4 {
			mode = Mode(n)
			break
		}
		fmt.Fprintln(out, "  Escolha 1, 2, 3 ou 4.")
	}

	guild := pr.ask("Nome da organização (NOD_GUILD_NAME)", "AdvTeam")
	webUI := pr.askBool("Ativar Portal Web (WEB_UI)?", true)
	minVer := pr.ask("Versão mínima do app (NOD_MIN_APP_VERSION)", "0.3.0")

	plan := Plan{}

	switch mode {
	case ModeDuckDNS:
		plan.ComposeFile = "host/compose.duckdns.yaml"

		var rng *PortRange
		rawRange := pr.ask("Range de portas abertas na máquina (ex: 8440-8450, ou Enter para pular)", "")
		if rawRange != "" {
			if parsed, err := parsePortRange(rawRange); err == nil {
				rng = &parsed
			} else {
				fmt.Fprintf(out, "  Ignorando range inválido (%v).\n", err)
			}
		}

		defaultPort := 8443
		if rng != nil {
			defaultPort = rng.Min
		}
		httpsPort := pr.askPort("Porta HTTPS para o Caddy escutar (NOD_HTTPS_PORT)", defaultPort, rng)

		var domain string
		for {
			raw := pr.ask("Subdomínio no DuckDNS (ex: advteam-nod -> advteam-nod.duckdns.org)", "advteam-nod")
			d, err := normalizeDuckDomain(raw)
			if err != nil {
				fmt.Fprintf(out, "  %v\n", err)
				continue
			}
			domain = d
			break
		}

		token := pr.ask("Token do DuckDNS (DUCKDNS_TOKEN)", "SEU_TOKEN_DUCKDNS")
		internalPort := pr.askPort("Porta interna do container Nod (NOD_PORT)", 8080, nil)
		publicURL := formatPublicURL(domain, httpsPort)

		plan.Entries = []EnvEntry{
			{Key: "NOD_DOMAIN", Value: domain},
			{Key: "NOD_HTTPS_PORT", Value: strconv.Itoa(httpsPort)},
			{Key: "NOD_PUBLIC_URL", Value: publicURL},
			{Key: "NOD_GUILD_NAME", Value: guild},
			{Key: "DUCKDNS_TOKEN", Value: token},
			{Key: "NOD_PORT", Value: strconv.Itoa(internalPort)},
			{Key: "WEB_UI", Value: strconv.FormatBool(webUI)},
			{Key: "NOD_MIN_APP_VERSION", Value: minVer},
		}
		plan.Notes = append(plan.Notes,
			fmt.Sprintf("O DuckDNS fornece apenas o DNS (%s). O Caddy gera o certificado HTTPS válido automaticamente via Let's Encrypt (DNS-01) usando o DUCKDNS_TOKEN.", domain),
			fmt.Sprintf("Garanta que a porta TCP %d está aberta/redirecionada para a máquina.", httpsPort),
		)

	case ModeCoolifyHTTPS:
		plan.ComposeFile = "host/compose.coolify.yaml"
		var publicURL string
		for {
			raw := pr.askRequired("Endereço HTTPS público no Coolify (ex: https://nod.suaempresa.com.br)")
			u, err := normalizeHttpsURL(raw)
			if err != nil {
				fmt.Fprintf(out, "  %v\n", err)
				continue
			}
			publicURL = u
			break
		}
		internalPort := pr.askPort("Porta interna exposta ao Traefik (NOD_PORT)", 8080, nil)
		plan.Entries = []EnvEntry{
			{Key: "NOD_PUBLIC_URL", Value: publicURL},
			{Key: "NOD_GUILD_NAME", Value: guild},
			{Key: "NOD_PORT", Value: strconv.Itoa(internalPort)},
			{Key: "WEB_UI", Value: strconv.FormatBool(webUI)},
			{Key: "NOD_MIN_APP_VERSION", Value: minVer},
			{Key: "NOD_DEV", Value: "0"},
		}

	case ModeCoolifyTempHTTP:
		plan.ComposeFile = "host/compose.coolify.yaml"
		var publicURL string
		for {
			raw := pr.askRequired("URL temporária HTTP gerada pelo Coolify (ex: http://abc.1.2.3.4.sslip.io)")
			u, err := normalizeHttpURL(raw)
			if err != nil {
				fmt.Fprintf(out, "  %v\n", err)
				continue
			}
			publicURL = u
			break
		}
		internalPort := pr.askPort("Porta interna exposta ao Traefik (NOD_PORT)", 8080, nil)
		plan.Entries = []EnvEntry{
			{Key: "NOD_PUBLIC_URL", Value: publicURL},
			{Key: "NOD_GUILD_NAME", Value: guild},
			{Key: "NOD_PORT", Value: strconv.Itoa(internalPort)},
			{Key: "WEB_UI", Value: strconv.FormatBool(webUI)},
			{Key: "NOD_MIN_APP_VERSION", Value: minVer},
			{Key: "NOD_DEV", Value: "1"},
		}
		plan.Notes = append(plan.Notes,
			"Com NOD_DEV=1 e HTTP fora de loopback, o Portal Web funciona, mas o app desktop do Nod recusa endereços http:// não-loopback.",
		)

	case ModeTunnelOrDirect:
		plan.ComposeFile = "host/compose.yaml"
		isLoopback := pr.askBool("Vai acessar via túnel SSH / loopback (http://127.0.0.1)?", false)
		port := pr.askPort("Porta do host (NOD_PORT)", 8080, nil)
		bind := "127.0.0.1"
		dev := "0"
		var publicURL string
		if isLoopback {
			dev = "1"
			publicURL = fmt.Sprintf("http://127.0.0.1:%d", port)
			plan.Notes = append(plan.Notes, fmt.Sprintf("Na sua máquina, conecte com: ssh -L %d:127.0.0.1:%d usuario@servidor", port, port))
		} else {
			bind = pr.ask("Interface de bind (NOD_BIND: 127.0.0.1 para Tailscale Serve, 0.0.0.0 para direto)", "127.0.0.1")
			for {
				raw := pr.askRequired("URL HTTPS pública (ex: https://maquina.tailnet.ts.net)")
				u, err := normalizeHttpsURL(raw)
				if err != nil {
					fmt.Fprintf(out, "  %v\n", err)
					continue
				}
				publicURL = u
				break
			}
			if bind == "127.0.0.1" {
				plan.Notes = append(plan.Notes, fmt.Sprintf("No servidor, publique com: tailscale serve --bg %d", port))
			}
		}
		plan.Entries = []EnvEntry{
			{Key: "NOD_PUBLIC_URL", Value: publicURL},
			{Key: "NOD_GUILD_NAME", Value: guild},
			{Key: "NOD_BIND", Value: bind},
			{Key: "NOD_PORT", Value: strconv.Itoa(port)},
			{Key: "WEB_UI", Value: strconv.FormatBool(webUI)},
			{Key: "NOD_MIN_APP_VERSION", Value: minVer},
			{Key: "NOD_DEV", Value: dev},
		}
	}

	return plan, nil
}

func main() {
	plan, err := runWizard(os.Stdin, os.Stdout)
	if err != nil {
		fmt.Fprintf(os.Stderr, "erro: %v\n", err)
		os.Exit(1)
	}
	fmt.Print(formatPlan(plan))
}
