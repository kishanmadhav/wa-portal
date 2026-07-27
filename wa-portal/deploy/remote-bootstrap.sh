#!/bin/bash
# Runs ON the Lightsail box. Assembles the stack dir, clones OpenWA, brings it up.
set -e
cd /home/ubuntu/wa-stack

echo "== cloning OpenWA (shallow) =="
if [ ! -d openwa/.git ]; then
  rm -rf openwa
  git clone --depth 1 https://github.com/rmyndharis/OpenWA.git openwa
else
  (cd openwa && git pull --ff-only || true)
fi

echo "== bringing up the stack =="
# compose.env supplies the ${...} variables used in the compose file.
docker compose --env-file compose.env -f docker-compose.prod.yml up -d --build

echo "== waiting for postgres, then migrate =="
sleep 8
docker compose --env-file compose.env -f docker-compose.prod.yml exec -T portal npm run migrate || true

echo "== status =="
docker compose --env-file compose.env -f docker-compose.prod.yml ps
echo "DONE"
