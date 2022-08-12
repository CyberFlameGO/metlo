echo "INSTALLING SURICATA"
sudo add-apt-repository ppa:oisf/suricata-stable -y
sudo apt install suricata -y
sudo systemctl enable suricata.service
sudo systemctl stop suricata.service
sudo mkdir /etc/suricata-logs
sudo chmod 777 /etc/suricata-logs

sudo mkdir /var/lib/suricata
sudo mkdir /var/lib/suricata/rules
sudo mv ~/local.rules /var/lib/suricata/rules/local.rules -f

sudo mv ~/suricata.yaml /etc/suricata/suricata.yaml -f

sudo mkdir /usr/local/nvm
sudo mkdir /etc/metlo-ingestor

echo "INSTALL NODE AND YARN"
source $HOME/.nvm/nvm.sh
nvm install 17.9.1
nvm use 17.9.1
npm install -g yarn

echo "CLONING INGESTOR"
cd /etc
sudo chmod 777 /etc/metlo-ingestor
git clone https://github.com/metlo-labs/metlo.git metlo-ingestor
cd metlo-ingestor/ingestors/suricata
yarn install
yarn build

echo "ADDING SERVICE"
sudo mv ~/metlo-ingestor.service /lib/systemd/system/metlo-ingestor.service -f

echo "STARTING SERVICES"
sudo systemctl daemon-reload
sudo systemctl enable metlo-ingestor.service
sudo systemctl start metlo-ingestor.service
sudo systemctl start suricata.service