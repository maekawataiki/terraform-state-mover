# --- Data Layer (should be split out) ---

resource "aws_db_subnet_group" "main" {
  name       = "main-db-subnet"
  subnet_ids = [aws_subnet.private_a.id, aws_subnet.private_b.id]
}

resource "aws_db_parameter_group" "postgres15" {
  name   = "custom-postgres15"
  family = "postgres15"

  parameter {
    name  = "log_connections"
    value = "1"
  }
}

resource "aws_kms_key" "rds_encryption" {
  description = "RDS encryption key"
}

resource "aws_db_instance" "main" {
  identifier           = "main-db"
  engine               = "postgres"
  engine_version       = "15.4"
  instance_class       = "db.r6g.large"
  allocated_storage    = 100
  db_subnet_group_name = aws_db_subnet_group.main.name
  parameter_group_name = aws_db_parameter_group.postgres15.name
  vpc_security_group_ids = [aws_security_group.db.id]
  kms_key_id           = aws_kms_key.rds_encryption.arn
  storage_encrypted    = true
  skip_final_snapshot  = false
}

resource "aws_secretsmanager_secret" "db_password" {
  name = "main-db-password"
}

resource "aws_dynamodb_table" "sessions" {
  name         = "user-sessions"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "session_id"

  attribute {
    name = "session_id"
    type = "S"
  }

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }
}

resource "aws_elasticache_cluster" "redis" {
  cluster_id      = "app-cache"
  engine          = "redis"
  node_type       = "cache.r6g.large"
  num_cache_nodes = 1
}

resource "aws_kinesis_stream" "events" {
  name             = "app-events"
  shard_count      = 2
  retention_period = 168
}

resource "aws_s3_bucket" "data_lake" {
  bucket = "company-data-lake-ap-northeast-1"
}
