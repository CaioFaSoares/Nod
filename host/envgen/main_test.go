package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestNormalizeDuckDomain(t *testing.T) {
	cases := []struct {
		raw, want       string
		wantErr         bool
	}{
		{"advteam-nod", "advteam-nod.duckdns.org", false},
		{"advteam-powerline.duckdns.org", "advteam-powerline.duckdns.org", false},
		{"https://AdvTeam-Nod.duckdns.org/", "advteam-nod.duckdns.org", false},
		{"nod.advteam", "", true},
		{"", "", true},
	}
	for _, tc := range cases {
		got, err := normalizeDuckDomain(tc.raw)
		if (err != nil) != tc.wantErr {
			t.Fatalf("normalizeDuckDomain(%q) err=%v, wantErr=%v", tc.raw, err, tc.wantErr)
		}
		if got != tc.want {
			t.Fatalf("normalizeDuckDomain(%q) = %q, want %q", tc.raw, got, tc.want)
		}
	}
}

func TestParsePortRange(t *testing.T) {
	r, err := parsePortRange("8440-8450")
	if err != nil || r.Min != 8440 || r.Max != 8450 {
		t.Fatalf("got (%+v, %v)", r, err)
	}
	r2, err := parsePortRange("9443")
	if err != nil || r2.Min != 9443 || r2.Max != 9443 {
		t.Fatalf("got (%+v, %v)", r2, err)
	}
	if _, err := parsePortRange("9000-8000"); err == nil {
		t.Fatal("expected error for inverted range")
	}
}

func TestFormatPublicURL(t *testing.T) {
	if got := formatPublicURL("nod.advteam.duckdns.org", 443); got != "https://nod.advteam.duckdns.org" {
		t.Fatalf("got %q", got)
	}
	if got := formatPublicURL("nod.advteam.duckdns.org", 8443); got != "https://nod.advteam.duckdns.org:8443" {
		t.Fatalf("got %q", got)
	}
}

func TestWizardDuckDNSFlow(t *testing.T) {
	input := strings.Join([]string{
		"1",
		"AdvTeam",
		"s",
		"0.3.0",
		"8440-8450",
		"8443",
		"advteam-nod",
		"tok-123",
		"8080",
	}, "\n") + "\n"

	var out bytes.Buffer
	plan, err := runWizard(strings.NewReader(input), &out)
	if err != nil {
		t.Fatalf("runWizard failed: %v", err)
	}
	if plan.ComposeFile != "host/compose.duckdns.yaml" {
		t.Fatalf("unexpected compose file: %s", plan.ComposeFile)
	}
	rendered := formatPlan(plan)
	for _, expected := range []string{
		"NOD_DOMAIN=advteam-nod.duckdns.org",
		"NOD_HTTPS_PORT=8443",
		"NOD_PUBLIC_URL=https://advteam-nod.duckdns.org:8443",
		"NOD_GUILD_NAME=AdvTeam",
		"DUCKDNS_TOKEN=tok-123",
	} {
		if !strings.Contains(rendered, expected) {
			t.Fatalf("missing %q in:\n%s", expected, rendered)
		}
	}
}
