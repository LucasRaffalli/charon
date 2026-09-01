# Certificats de test

Fabriqués par `ssh-keygen`, avec une fenêtre de validité **fixe**
(2026-01-01 → 2027-01-01) : les tests passent un instant choisi plutôt que
l'heure courante, sinon ils se mettraient à échouer tout seuls le jour de
l'expiration.

Seules les parties **publiques** sont ici. Les clés privées des autorités ont
été détruites après la signature : un dépôt n'héberge pas de clé privée, même
de test, même inoffensive. Pour refabriquer le lot :

```sh
ssh-keygen -q -t ed25519 -N "" -f ca       -C autorite-de-test
ssh-keygen -q -t ed25519 -N "" -f autre-ca -C autre-autorite
ssh-keygen -q -t ed25519 -N "" -f hote     -C cle-hote

# valide : certificat d'hôte, principal vps.example.com
ssh-keygen -q -s ca -I test-hote -h -n vps.example.com \
  -V 20260101000000:20270101000000 -z 1 hote.pub && mv hote-cert.pub valide-cert.pub

# signé par une autorité qu'on n'a pas approuvée
ssh-keygen -q -s autre-ca -I autre -h -n vps.example.com \
  -V 20260101000000:20270101000000 -z 2 hote.pub && mv hote-cert.pub autre-ca-cert.pub

# certificat d'UTILISATEUR (pas de -h) : ne prouve rien sur un hôte
ssh-keygen -q -s ca -I util -n vps.example.com \
  -V 20260101000000:20270101000000 -z 3 hote.pub && mv hote-cert.pub utilisateur-cert.pub

# émis pour une autre machine
ssh-keygen -q -s ca -I mauvais -h -n autre.example.com \
  -V 20260101000000:20270101000000 -z 4 hote.pub && mv hote-cert.pub mauvais-hote-cert.pub

rm -f ca autre-ca hote          # les privées ne restent pas
```

L'expiration ne demande pas de fixture : les tests appellent la validation avec
un instant hors de la fenêtre.
