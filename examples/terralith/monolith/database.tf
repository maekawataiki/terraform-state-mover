resource "aws_db_instance" "primary" {
  identifier             = "prod-primary"
  engine                 = "postgres"
  instance_class         = "db.r5.xlarge"
  db_subnet_group_name   = "prod-db-subnet"
  vpc_security_group_ids = [aws_vpc.main.id]
}

resource "aws_elasticache_cluster" "redis" {
  cluster_id        = "prod-redis"
  engine            = "redis"
  node_type         = "cache.r5.large"
  num_cache_nodes   = 3
  subnet_group_name = "prod-cache-subnet"
}
