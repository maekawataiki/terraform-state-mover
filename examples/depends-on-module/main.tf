resource "aws_rds_cluster" "main" {
  cluster_identifier = "prod-db"
  engine             = "aurora-postgresql"
  master_username    = "admin"
  master_password    = "changeme"
}

module "app" {
  source     = "./modules/app"
  vpc_id     = "vpc-123"
  depends_on = [aws_rds_cluster.main]
}

module "worker" {
  source     = "./modules/worker"
  queue_url  = "https://sqs.us-east-1.amazonaws.com/123/queue"
  depends_on = [module.app, aws_rds_cluster.main]
}
